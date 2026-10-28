<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Hls from 'hls.js';
  import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { EpisodeDetail, ItemDetails, PlayResponse, SavedPosition, SessionTracks } from '@tv/shared';
  import { api, ApiClientError } from '$lib/api';
  import { getClientId } from '$lib/clientId';
  import NowList from '$lib/components/guide/NowList.svelte';
  import PlayerControls from '$lib/components/player/PlayerControls.svelte';
  import TrackSheet from '$lib/components/player/TrackSheet.svelte';
  import EpisodeRow from '$lib/components/series/EpisodeRow.svelte';
  import PlayerStates, { type PlayerView } from '$lib/components/watch/PlayerStates.svelte';
  import UpNext from '$lib/components/watch/UpNext.svelte';
  import WatchActions, { type WatchAction } from '$lib/components/watch/WatchActions.svelte';
  import WatchInfo from '$lib/components/watch/WatchInfo.svelte';
  import { sharedClock } from '$lib/guide/time';
  import { favourite, itemDetails, positions, reportPosition, unfavourite } from '$lib/me';
  import { messageFor } from '$lib/messages';
  import { attachStream } from '$lib/player/attach';
  import { applyNativeDefaults, enableAudio, nativeTracks, showSubtitle } from '$lib/player/nativeTracks';
  import { createOrientation } from '$lib/player/orientation.svelte.ts';
  import { createPlayback, type StartParams } from '$lib/player/playback';
  import { createProgressReporter } from '$lib/player/progress';
  import { createPlayerState, type PlayerState } from '$lib/player/state.svelte.ts';
  import { canAirPlay, canPip, setNowPlaying, showAirPlay, togglePip } from '$lib/player/system';
  import { rememberSubtitleLanguage, subtitleLanguage } from '$lib/player/trackPrefs';
  import { pickResume } from '$lib/resume';
  import { releaseSession, startHeartbeat } from '$lib/session';
  import { createChannelList } from '$lib/watch/channelList.svelte.ts';
  import { neighbour } from '$lib/watch/channels';
  import { nextEpisode, seasonOf } from '$lib/watch/episodes';
  import { watchHref } from '$lib/watch/links';
  import { createOnNow } from '$lib/watch/onNow.svelte.ts';
  import { parseWatchParams, type WatchParams } from '$lib/watch/params';

  type Kind = StartParams['kind'];

  /**
   * Moving on within the page (another channel or episode, From start, Watch live) replaces its history entry, so Back
   * still leaves it.
   */
  const REPLACE = { replaceState: true };
  /** The lock screen's skips, as the controls'. */
  const SKIP_SEC = 10;
  /** A subtitle language /api/play takes. */
  const LANGUAGE = /^[a-z]{2,3}$/;

  let video = $state<HTMLVideoElement>();
  let player = $state<PlayerState>();
  /** What covers the video; null while it plays. */
  let view = $state<PlayerView | null>({ kind: 'starting' });
  /** The probed length of the movie, episode or catch-up programme: the element's own duration grows while remuxing. */
  let durationSec = $state<number | null>(null);
  let manualFullscreen = $state(false);
  let moreOpen = $state(false);
  /** A movie's or episode's tracks on offer and in use: an HLS session's from the server, a direct file's from the element. */
  let tracks = $state.raw<SessionTracks | null>(null);
  /** How the latest start streams: an HLS session switches tracks by restarting, a direct file in the element. */
  let streamMode: PlayResponse['mode'] | null = null;
  let trackSheetOpen = $state(false);
  // Kept once the sheet closes: ActionSheet closes it before running the pick.
  let trackSheetKind = $state<'audio' | 'subtitles'>('subtitles');
  /** The episode the Up next card counts down to, from the end of this one until it plays or is cancelled. */
  let upNext = $state.raw<EpisodeDetail | null>(null);
  /** A seek or track change is starting its new session: the old picture is gone until the new one plays. */
  let restarting = $state(false);
  let begun = 0; // bumped on every begin(), so a late answer for an old URL is ignored
  let inAppHistory = false; // whether this page was reached from another page of the app, which Back can return to

  const params = $derived(parseWatchParams(page.url));
  const onNow = createOnNow();
  const orientation = createOrientation();
  // Sideways, or after ⤢: the video fills the screen. The same <video> stays, so playback carries on.
  const fullscreen = $derived(orientation.landscape || manualFullscreen);

  /**
   * Catch-up and episodes say what they are, and so does a channel opened from a live guide, which links with its
   * category. Otherwise a plain item is a channel or a movie, which only the item knows.
   */
  function kindNow(p: WatchParams): Kind | null {
    if (p.catchup) return 'catchup';
    if (p.episode) return 'episode';
    if (p.category) return 'live';
    const it = onNow.item;
    return it && it.id === p.itemId ? (it.kind === 'live' ? 'live' : 'movie') : null;
  }
  const kind = $derived(kindNow(params));
  const channel = $derived(kind === 'live' || kind === 'catchup');
  const vod = $derived(kind === 'movie' || kind === 'episode');
  const itemId = $derived(params.itemId);
  const askedCategory = $derived(params.category);
  const name = $derived(onNow.item?.displayName ?? '');

  const reporter = createProgressReporter({ report: reportPosition, now: Date.now });

  const playback = createPlayback({
    play: (req, signal) => api<PlayResponse>('/api/play', { method: 'POST', body: JSON.stringify(req), signal }),
    releaseSession: (sessionId, clientId) => releaseSession(sessionId, clientId),
    startHeartbeat: (sessionId, clientId, opts) => startHeartbeat(sessionId, clientId, opts),
    attachStream: (v, url, opts) => attachStream(v, url, { Hls, ...opts }),
    clientId: getClientId,
    onStarted: ({ offsetSec, durationSec: total, mode, tracks: offered, handle }) => {
      durationSec = total;
      const started = playback.current();
      if (!video || !started) return;
      // A direct file's tracks are read from the element once it is open (onMetadata).
      streamMode = mode;
      tracks = offered;
      // The session's subtitle rendition carries no language for the player to pick it by: show it outright.
      if (offered && offered.subtitleIndex !== null) handle.showSubtitles(true);
      autoplay(video);
      // Live has nothing to resume; catch-up has a duration but is never progress-tracked.
      if (total === null || started.params.catchup) return;
      const { itemId, episodeRemoteId } = started.params;
      reporter.attach(video, { itemId, episodeRemoteId, offsetSec, durationSec: total });
    },
    onStopping: () => {
      void reporter.flush();
      reporter.detach();
    },
    onRestarting: () => {
      restarting = true;
    },
    onGone: () => {
      // The Resume choice is for the title switched to: whatever played before it has nothing to restart.
      if (view?.kind !== 'resume') view = { kind: 'stopped' };
    },
    onError: (err) => {
      let message = 'Something went wrong. Please try again.';
      // The server says why a catch-up window was refused: no catch-up on this channel, too old, and so on.
      if (err instanceof ApiClientError) {
        message = err.code === 'VALIDATION' && params.catchup ? err.message : messageFor(err, { kind: kind ?? undefined });
      }
      // Trying again here can't free the stream another device is using.
      const retry = !(err instanceof ApiClientError && err.code === 'PROVIDER_CONNECTION_LIMIT');
      view = { kind: 'failed', message, retry };
    },
  });

  // Positions are absolute. A restart has no offset until its new session is attached, and by then the old source is
  // gone (currentTime 0), so meanwhile the position shown is where the restart is headed.
  const offsetSec = () => playback.current()?.offsetSec ?? (video ? playback.absoluteSec(video) : 0);

  $effect(() => {
    if (!video) return;
    const state = createPlayerState(video, offsetSec);
    player = state;
    return () => state.destroy();
  });

  /** Bumped as each stream opens: Safari says whether a video can go picture-in-picture only once one is loaded. */
  let opened = $state(0);
  const caps = $derived.by(() => {
    void opened;
    return video ? { pip: canPip(video), airplay: canAirPlay() } : { pip: false, airplay: false };
  });

  // A restart on its way, or a stall while playing: a spinner over the video. Unlike the states that cover it, it takes
  // no taps, so Back, pause and the rest of the controls still work.
  const loading = $derived(view === null && upNext === null && (restarting || (player?.waiting === true && !player.paused)));

  // Turning the phone takes over from ⤢: upright again is the upright page.
  $effect(() => {
    void orientation.landscape;
    manualFullscreen = false;
  });

  /** A channel's category, the channels in it, and what follows the programme on now. */
  const list = createChannelList({
    get channel() {
      return channel;
    },
    get live() {
      return kind === 'live';
    },
    get itemId() {
      return itemId;
    },
    get askedCategory() {
      return askedCategory;
    },
    get item() {
      return onNow.item;
    },
  });
  /** Back says where it goes: a channel's category or Favourites once known, an episode's series, or Movies. */
  const backLabel = $derived(channel ? list.label || null : kind === 'episode' ? name || null : kind === 'movie' ? 'Movies' : null);

  /** A movie's or series' details: its plot and genre, and a series' seasons and episodes. */
  let loaded = $state.raw<{ itemId: number; details: ItemDetails } | null>(null);
  $effect(() => {
    if (!vod) return;
    const id = itemId;
    let cancelled = false;
    itemDetails(id).then(
      (d) => {
        if (!cancelled) loaded = { itemId: id, details: d };
      },
      () => {}, // without them: the title alone, and no episode list
    );
    return () => {
      cancelled = true;
    };
  });
  const details = $derived(loaded?.itemId === itemId ? loaded.details : null);
  const seasons = $derived(details?.kind === 'series' ? details.seasons : []);
  const season = $derived(kind === 'episode' && params.episode ? seasonOf(seasons, params.episode) : null);
  const episode = $derived(season?.episodes.find((e) => e.remoteId === params.episode) ?? null);
  const nextEp = $derived(kind === 'episode' && params.episode ? nextEpisode(seasons, params.episode) : null);
  /** "S1 E2 · Title": the episode on the lock screen and in the sideways title. */
  const episodeLabel = $derived(season && episode ? `S${season.season} E${episode.episodeNum} · ${episode.title}` : null);
  const poster = $derived(details?.posterUrl ?? onNow.item?.logoUrl ?? null);

  /** The movie's or series' saved positions, for the episode rows. */
  let saved = $state.raw<{ itemId: number; list: SavedPosition[] } | null>(null);
  const savedByEpisode = $derived(new Map((saved?.itemId === itemId ? saved.list : []).map((p) => [p.episodeRemoteId, p])));

  const trackLabels = $derived.by(() => {
    const t = tracks;
    if (!t) return { audio: null, subtitles: null };
    return {
      audio: t.audio.find((a) => a.index === t.audioIndex)?.label ?? null,
      subtitles: t.subtitles.find((s) => s.index === t.subtitleIndex)?.label ?? 'Off',
    };
  });
  /** Choosing audio needs more than one track. */
  const audioChoice = $derived(vod && (tracks?.audio.length ?? 0) > 1);

  // The live bar is the programme on the clock. The stream counts its own time; its live edge is now.
  const liveShiftSec = $derived(kind === 'live' && player?.window ? Date.now() / 1000 - player.window.endSec : 0);

  // Catch-up of a programme still on: its bar ends at now, and "● Watch live" sits beside it.
  const clock = sharedClock();
  const airing = $derived(kind === 'catchup' && params.catchup !== null && params.catchup.stopSec * 1000 > clock.nowMs);
  const barSec = $derived(
    airing && params.catchup && durationSec !== null
      ? Math.min(durationSec, Math.floor(clock.nowMs / 1000) - params.catchup.startSec)
      : durationSec,
  );

  /** A favourite toggled here, until the item says so itself. */
  let favourited = $state<{ itemId: number; on: boolean } | null>(null);
  const isFavourite = $derived(favourited?.itemId === itemId ? favourited.on : (onNow.item?.favourite ?? false));

  // The lock screen and Control Centre: the channel and its programme, with previous and next channel.
  $effect(() => {
    const it = onNow.item;
    if (!channel || !it || it.id !== itemId) return;
    const live = kind === 'live';
    const actions: Parameters<typeof setNowPlaying>[1] = { play: resumePlayback, pause: pausePlayback };
    if (live && neighbour(list.order, it.id, -1) !== null) actions.previoustrack = () => switchChannel(-1);
    if (live && neighbour(list.order, it.id, 1) !== null) actions.nexttrack = () => switchChannel(1);
    const artist = live ? onNow.onNow?.title : params.catchup?.title || undefined;
    setNowPlaying({ title: it.displayName, artist, artworkUrl: it.logoUrl ?? undefined }, actions);
  });

  // A movie or episode: its title, the movie or series, and the poster, with skips back and forward.
  $effect(() => {
    const it = onNow.item;
    if (!vod || !it || it.id !== itemId) return;
    const title = kind === 'episode' ? (episodeLabel ?? it.displayName) : it.displayName;
    setNowPlaying(
      { title, artist: it.displayName, artworkUrl: poster ?? undefined },
      { play: resumePlayback, pause: pausePlayback, seekbackward: () => skip(-SKIP_SEC), seekforward: () => skip(SKIP_SEC) },
    );
  });

  /** Plays the new stream. A browser that won't start it without a tap gets Tap to play. */
  function autoplay(v: HTMLVideoElement) {
    v.play().catch((err: unknown) => {
      const refused = (err as { name?: string } | null)?.name === 'NotAllowedError';
      if (refused && v.paused && (view === null || view.kind === 'starting')) view = { kind: 'tapToPlay' };
    });
  }

  function start(startAtSec: number) {
    if (!video) return;
    view = { kind: 'starting' };
    restarting = false; // Starting says so itself
    const p = params;
    const mine = begun;
    const play = (k: Kind) => {
      if (mine !== begun || !video) return;
      const catchup = p.catchup ? { startSec: p.catchup.startSec, stopSec: p.catchup.stopSec } : undefined;
      const req: StartParams = { kind: k, itemId: p.itemId, episodeRemoteId: p.episode ?? undefined, startAtSec, catchup };
      // A movie or episode starts with subtitles in the remembered language, when it has a text track in it.
      if (k === 'movie' || k === 'episode') req.subtitleLanguage = rememberedLanguage();
      void playback.start(req, video);
    };
    const known = kindNow(p);
    if (known) return play(known);
    // An item that can't be fetched still plays, as a movie: its seeks restart the session, which a channel ignores.
    void onNow.load(p.itemId).then((it) => play(it?.kind === 'live' ? 'live' : 'movie'));
  }

  /**
   * Tap to restart and Try again: a movie, episode or catch-up programme carries on from where it was, or from where a
   * start that failed was headed.
   */
  function restart() {
    start(playback.isVod() && video ? playback.absoluteSec(video) : 0);
  }

  /** Starts playback for the current URL: catch-up, an explicit time, the resume prompt, or from the top. */
  function begin() {
    const mine = ++begun;
    if (!video) return;
    const p = params;
    durationSec = null;
    tracks = null;
    trackSheetOpen = false;
    upNext = null;
    void onNow.load(p.itemId);
    if (p.catchup) return start(0);
    if (p.t) return start(p.t);
    if (kindNow(p) === 'live') return start(0); // nothing to resume
    view = { kind: 'starting' };
    positions(p.itemId).then(
      (list) => {
        if (mine !== begun) return;
        saved = { itemId: p.itemId, list };
        const best = pickResume(list, p.episode);
        if (!best) return start(0);
        // Whatever played before (another episode, from the rows or Up next) stops now, its place saved, rather than
        // playing on under the choice and holding the provider's stream.
        playback.teardown();
        view = { kind: 'resume', atSec: best.positionSec };
      },
      () => mine === begun && start(0), // no saved position available: just play
    );
  }

  // SvelteKit reuses this component when only the query changes, so the URL drives playback.
  $effect(() => {
    void page.url.search;
    untrack(begin);
  });

  async function fromStart() {
    const id = onNow.item?.id;
    let now = onNow.onNow;
    // The programme ended before the page noticed: start the one on now instead, if any.
    if (now && now.stopSec * 1000 <= Date.now()) {
      await onNow.refetch();
      now = onNow.onNow;
    }
    if (id === undefined || !now || onNow.item?.id !== id) return;
    void goto(watchHref(id, { category: list.category, catchup: now }), REPLACE);
  }

  /** "● Watch live": this channel, live. */
  function watchLive() {
    void goto(watchHref(itemId, { category: list.category }), REPLACE);
  }

  /** Channel up or down, in the list's order. The playing session is released as the next one starts. */
  function switchChannel(dir: -1 | 1) {
    const id = neighbour(list.order, itemId, dir);
    if (id !== null) void goto(watchHref(id, { category: list.category }), REPLACE);
  }

  function openGuide() {
    void goto(list.guideHref);
  }

  /** Another episode of the series, as the rows below play it. The playing session is released as the next one starts. */
  function playEpisode(ep: EpisodeDetail) {
    void goto(watchHref(itemId, { episode: ep.remoteId }), REPLACE);
  }

  /** The remembered subtitle language, when it is one /api/play takes. */
  function rememberedLanguage(): string | null {
    const lang = subtitleLanguage();
    return lang !== null && LANGUAGE.test(lang) ? lang : null;
  }

  function openTracks(k: 'audio' | 'subtitles') {
    trackSheetKind = k;
    trackSheetOpen = true;
  }

  /** A pick from the Audio or Subtitles sheet: index null is subtitles Off. */
  function pickTrack(k: 'audio' | 'subtitles', index: number | null) {
    const v = video;
    const now = tracks;
    if (!v || !now) return;
    if (k === 'subtitles') {
      // The next title starts the same way: with this language's subtitles, or with none after Off (even when this one
      // found none to show).
      const language = now.subtitles.find((t) => t.index === index)?.language ?? null;
      if (index === null) rememberSubtitleLanguage(null);
      else if (language !== null && LANGUAGE.test(language)) rememberSubtitleLanguage(language);
    }
    if ((k === 'audio' ? now.audioIndex : now.subtitleIndex) === index) return; // already playing
    if (streamMode === 'direct') {
      // The whole file is here: the element switches its own tracks.
      if (k === 'subtitles') showSubtitle(v, index);
      else if (index !== null) enableAudio(v, index);
      tracks = nativeTracks(v);
      return;
    }
    // An HLS session carries one audio track and one subtitle rendition: another is a new session from here. A second
    // pick before it starts supersedes it, and playback releases the one it replaces.
    tracks = k === 'audio' ? { ...now, audioIndex: index } : { ...now, subtitleIndex: index };
    if (k === 'subtitles') void playback.restartWith(v, { subtitleIndex: index });
    else if (index !== null) void playback.restartWith(v, { audioIndex: index });
  }

  /** A stream is open. A direct file: English audio, the remembered language's subtitles, and its tracks for the sheets. */
  function onMetadata() {
    opened++;
    if (!video || !vod || streamMode !== 'direct') return;
    applyNativeDefaults(video, rememberedLanguage());
    tracks = nativeTracks(video);
  }

  /** The end of an episode: Up next counts down to the next one, if there is one. */
  function onEnded() {
    void reporter.flush(); // the episode is left at its end, so its row says watched once Up next moves on
    if (kind === 'episode' && nextEp) upNext = nextEp;
  }

  async function toggleFavourite() {
    const id = onNow.item?.id;
    if (id === undefined || id !== itemId) return;
    const was = isFavourite;
    favourited = { itemId: id, on: !was };
    try {
      await (was ? unfavourite(id) : favourite(id));
    } catch {
      if (favourited?.itemId === id) favourited = { itemId: id, on: was };
    }
  }

  // Navigations within the page don't count: they replace their entry, so behind it is still where it was opened from.
  // Nor does the app's first load, which in a single-page app comes from a page with no URL.
  afterNavigate((nav) => {
    const from = nav.from?.url;
    if (from && from.pathname !== '/watch') inAppHistory = true;
  });

  /** Back where you came from. Opened from outside the app (a bookmark, a link, a relaunch), to the list it belongs to. */
  function back() {
    if (inAppHistory) return history.back();
    let home = list.guideHref;
    if (kind === 'movie') home = '/browse/movie';
    else if (kind === 'episode') home = `/series/${itemId}`;
    void goto(home, { replaceState: true });
  }

  // While something covers the video, the transport does nothing: a seek would start a session under the cover.
  function togglePlay() {
    if (video?.paused) resumePlayback();
    else pausePlayback();
  }

  function resumePlayback() {
    if (video && !view) video.play().catch(() => {});
  }

  function pausePlayback() {
    if (video && !view) video.pause();
  }

  function skip(delta: number) {
    if (video && !view) void playback.seekTo(video, playback.absoluteSec(video) + delta);
  }

  function seek(sec: number) {
    if (video && !view) void playback.seekTo(video, sec);
  }

  function goLive() {
    if (video && !view && player?.window) void playback.seekTo(video, player.window.endSec);
  }

  function toggleMute() {
    if (video) video.muted = !video.muted;
  }

  function toggleFullscreen() {
    manualFullscreen = !fullscreen;
  }

  function pip() {
    if (video) void togglePip(video);
  }

  function airplay() {
    if (video) showAirPlay(video);
  }

  function tapToPlay() {
    if (video) video.play().catch(() => {});
  }

  function resume() {
    if (view?.kind === 'resume') start(view.atSec);
  }

  /** Playing: whatever covers the video goes, except the Resume choice, which waits for an answer. */
  function onPlaying() {
    restarting = false;
    if (view && view.kind !== 'resume') view = null;
  }

  function onPlay() {
    if (view?.kind === 'tapToPlay') view = null;
  }

  /** A stream the element can't play. One that dies with a stopped or refused session has nothing new to say. */
  function onVideoError() {
    if (view === null || view.kind === 'starting' || view.kind === 'tapToPlay') view = { kind: 'error' };
  }

  // Live: ★ From start, Guide. Catch-up: ★ Watch live, Guide. Episode: ★ (the series), Next episode, Subtitles.
  // Movie: ★ PiP, AirPlay. The rest goes in More.
  const actions = $derived.by(() => {
    const row: WatchAction[] = [];
    const subtitles: WatchAction = { key: 'subtitles', icon: '💬', label: 'Subtitles', run: () => openTracks('subtitles') };
    if (kind) row.push({ key: 'favourite', icon: '★', label: 'Favourite', pressed: isFavourite, run: toggleFavourite });
    if (kind === 'live' && onNow.onNow && (onNow.item?.catchupDays ?? 0) > 0) {
      row.push({ key: 'from-start', icon: '↺', label: 'From start', run: fromStart });
    }
    if (kind === 'catchup') row.push({ key: 'watch-live', icon: '●', label: 'Watch live', run: watchLive });
    if (channel) row.push({ key: 'guide', icon: '▦', label: 'Guide', run: openGuide });
    const next = nextEp;
    if (next) row.push({ key: 'next-episode', icon: '⏭', label: 'Next episode', run: () => playEpisode(next) });
    if (kind === 'episode') row.push(subtitles);
    if (caps.pip) row.push({ key: 'pip', icon: '⧉', label: 'Picture in picture', run: pip });
    if (caps.airplay) row.push({ key: 'airplay', icon: '⎚', label: 'AirPlay', run: airplay });
    if (kind === 'movie') row.push(subtitles);
    if (audioChoice) row.push({ key: 'audio', icon: '♪', label: 'Audio', run: () => openTracks('audio') });
    // Sideways already fills the screen.
    if (!orientation.landscape) row.push({ key: 'fullscreen', icon: '⤢', label: 'Full screen', run: toggleFullscreen });
    return row;
  });

  beforeNavigate((nav) => {
    // A same-route navigation restarts playback itself; tearing down here would strand the video if it fails or is cancelled.
    if (nav.to?.url.pathname === '/watch') return;
    playback.teardown();
  });
  onDestroy(() => {
    playback.teardown();
    onNow.destroy();
    orientation.destroy();
    setNowPlaying(null, {});
  });
</script>

<svelte:window onpagehide={playback.teardown} />

<div class="watch" class:fullscreen>
  <header class="topbar">
    <button type="button" class="back" aria-label={backLabel ? `Back to ${backLabel}` : undefined} onclick={back}>‹ {backLabel ?? 'Back'}</button>
  </header>

  <div class="player">
    <video
      bind:this={video}
      playsinline
      autoplay
      onplay={onPlay}
      onplaying={onPlaying}
      onerror={onVideoError}
      onloadedmetadata={onMetadata}
      onended={onEnded}
    ></video>
    {#if player}
      <!-- Catch-up positions count from the programme's start, so its bar is the VOD one. -->
      <PlayerControls
        state={player}
        mode={kind === 'live' ? 'live' : 'vod'}
        title={name}
        subtitle={kind === 'catchup'
          ? params.catchup?.title || undefined
          : kind === 'live'
            ? onNow.onNow?.title
            : (episodeLabel ?? undefined)}
        nextLabel={kind === 'live' ? list.nextLabel : undefined}
        {fullscreen}
        programme={kind === 'live' ? onNow.onNow : null}
        {liveShiftSec}
        {caps}
        tracks={{ audio: audioChoice, subtitles: vod }}
        {trackLabels}
        durationSec={barSec}
        holding={moreOpen || trackSheetOpen}
        covered={view !== null || upNext !== null}
        onTogglePlay={togglePlay}
        onSkip={skip}
        onSeek={seek}
        onGoLive={kind === 'live' ? goLive : undefined}
        onWatchLive={airing ? watchLive : undefined}
        onChannel={kind === 'live' ? switchChannel : undefined}
        onPip={pip}
        onAirPlay={airplay}
        onToggleMute={toggleMute}
        onFullscreen={orientation.landscape ? undefined : toggleFullscreen}
        onTracks={openTracks}
        onBack={back}
      />
    {/if}
    {#if loading}
      <div class="loading" role="status" aria-label="Loading"><span class="spinner" aria-hidden="true"></span></div>
    {/if}
    {#if view}
      <PlayerStates
        {view}
        {name}
        artwork={poster}
        poster={vod}
        onResume={resume}
        onStartOver={() => start(0)}
        onRestart={restart}
        onPlay={tapToPlay}
      />
    {:else if upNext}
      <UpNext
        next={upNext}
        season={seasonOf(seasons, upNext.remoteId)?.season}
        onPlay={() => upNext && playEpisode(upNext)}
        onCancel={() => (upNext = null)}
      />
    {/if}
  </div>

  <WatchInfo
    {kind}
    item={onNow.item}
    onNow={onNow.onNow}
    catchup={params.catchup}
    where={list.where}
    next={list.nextLabel}
    {details}
    episode={season && episode ? { season: season.season, episode } : null}
  />
  <WatchActions {actions} bind:moreOpen />
  <TrackSheet
    open={trackSheetOpen}
    kind={trackSheetKind}
    tracks={(trackSheetKind === 'audio' ? tracks?.audio : tracks?.subtitles) ?? []}
    selected={(trackSheetKind === 'audio' ? tracks?.audioIndex : tracks?.subtitleIndex) ?? null}
    onPick={(index) => pickTrack(trackSheetKind, index)}
    onClose={() => (trackSheetOpen = false)}
  />

  {#if season}
    <!-- The season's episodes, the playing one highlighted. A row plays it in place of this history entry, so Back
         still returns to the series. -->
    <section class="switch" aria-label="Episodes" data-sveltekit-replacestate>
      <div class="lhead">
        <strong>{season.name}</strong>
        <span>{season.episodes.length} {season.episodes.length === 1 ? 'episode' : 'episodes'}</span>
      </div>
      <div class="episodes">
        {#each season.episodes as ep}
          <EpisodeRow
            episode={ep}
            {itemId}
            saved={savedByEpisode.get(ep.remoteId) ?? null}
            current={ep.remoteId === params.episode}
            href={watchHref(itemId, { episode: ep.remoteId })}
          />
        {/each}
      </div>
    </section>
  {/if}

  {#if list.filter}
    <!-- Something to switch to: the category's channels, the playing one highlighted. A row plays it live, in place of
         this history entry, as channel up and down do. -->
    <section class="switch" aria-label="Channels" data-sveltekit-replacestate>
      <div class="lhead">
        <strong>{list.label}</strong>
        {#if list.order.length > 0}<span>{list.order.length} {list.order.length === 1 ? 'channel' : 'channels'}</span>{/if}
      </div>
      <NowList filter={list.filter} label={list.label} currentItemId={itemId} />
    </section>
  {/if}
</div>

<style>
  .topbar {
    display: flex;
    align-items: center;
    padding: 2px 8px 4px;
  }
  .back {
    min-height: 44px;
    padding: 0 8px;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }
  .player {
    position: relative;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    background: #000;
  }
  video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #000;
  }
  /* A ring around the controls' play button, which stays usable inside it. */
  .loading {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    pointer-events: none;
  }
  .spinner {
    width: 76px;
    height: 76px;
    border-radius: 50%;
    border: 3px solid rgb(255 255 255 / 0.2);
    border-top-color: #fff;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .switch {
    padding: 0 16px 16px;
  }
  .lhead {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 6px 0 4px;
    color: var(--muted);
    font-size: 12px;
  }
  .lhead strong {
    font-size: 13px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .episodes {
    border-radius: 12px;
    background: var(--surface);
    overflow: hidden;
  }
  /* Sideways: video only. Sheets sit above it, so one left open stays usable. */
  .watch.fullscreen {
    height: 100dvh;
    overflow: hidden;
  }
  .fullscreen .player {
    position: fixed;
    inset: 0;
    z-index: 10;
    aspect-ratio: auto;
  }
</style>
