<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import Hls from 'hls.js';
  import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { PlayResponse, Programme, WatchContext } from '@tv/shared';
  import { api, ApiClientError } from '$lib/api';
  import { getClientId } from '$lib/clientId';
  import NowList from '$lib/components/guide/NowList.svelte';
  import PlayerControls from '$lib/components/player/PlayerControls.svelte';
  import PlayerStates, { type PlayerView } from '$lib/components/watch/PlayerStates.svelte';
  import WatchActions, { type WatchAction } from '$lib/components/watch/WatchActions.svelte';
  import WatchInfo from '$lib/components/watch/WatchInfo.svelte';
  import { programmes } from '$lib/guide';
  import { formatClock, sharedClock } from '$lib/guide/time';
  import { favourite, positions, reportPosition, unfavourite } from '$lib/me';
  import { messageFor } from '$lib/messages';
  import { attachStream } from '$lib/player/attach';
  import { createOrientation } from '$lib/player/orientation.svelte.ts';
  import { createPlayback, type StartParams } from '$lib/player/playback';
  import { createProgressReporter } from '$lib/player/progress';
  import { createPlayerState, type PlayerState } from '$lib/player/state.svelte.ts';
  import { canAirPlay, canPip, setNowPlaying, showAirPlay, togglePip } from '$lib/player/system';
  import { pickResume } from '$lib/resume';
  import { releaseSession, startHeartbeat } from '$lib/session';
  import { loadChannelOrder, neighbour } from '$lib/watch/channels';
  import { watchHref } from '$lib/watch/links';
  import { createOnNow } from '$lib/watch/onNow.svelte.ts';
  import { parseWatchParams, type WatchParams } from '$lib/watch/params';

  type Kind = StartParams['kind'];

  /** How far ahead the next programme is looked for. */
  const NEXT_WINDOW_SEC = 6 * 3600;

  let video = $state<HTMLVideoElement>();
  let player = $state<PlayerState>();
  /** What covers the video; null while it plays. */
  let view = $state<PlayerView | null>({ kind: 'starting' });
  /** The probed length of the movie, episode or catch-up programme: the element's own duration grows while remuxing. */
  let durationSec = $state<number | null>(null);
  let manualFullscreen = $state(false);
  let moreOpen = $state(false);
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
    onStarted: ({ offsetSec, durationSec: total }) => {
      durationSec = total;
      const started = playback.current();
      if (!video || !started) return;
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
    onGone: () => {
      view = { kind: 'stopped' };
    },
    onError: (err) => {
      let message = 'Something went wrong. Please try again.';
      // The server says why a catch-up window was refused: no catch-up on this channel, too old, and so on.
      if (err instanceof ApiClientError) message = err.code === 'VALIDATION' && params.catchup ? err.message : messageFor(err);
      view = { kind: 'failed', message };
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

  const caps = $derived(video ? { pip: canPip(video), airplay: canAirPlay() } : { pip: false, airplay: false });

  // Turning the phone takes over from ⤢: upright again is the upright page.
  $effect(() => {
    void orientation.landscape;
    manualFullscreen = false;
  });

  /** The server's word on a channel's category: the one asked for when it is one of the channel's, else its first visible one. */
  let context = $state.raw<(WatchContext & { itemId: number; asked: string | null }) | null>(null);
  $effect(() => {
    if (!channel) return;
    const id = itemId;
    const asked = askedCategory;
    let cancelled = false;
    api<WatchContext>(`/api/items/${id}/context${asked ? `?category=${encodeURIComponent(asked)}` : ''}`).then(
      (ctx) => {
        if (!cancelled) context = { ...ctx, itemId: id, asked };
      },
      () => {}, // no list is better than a broken page
    );
    return () => {
      cancelled = true;
    };
  });

  /** The channels below: the category the page was opened from, else the channel's first visible live category. */
  const category = $derived(
    askedCategory ?? (context?.itemId === itemId && context.categoryId !== null ? String(context.categoryId) : null),
  );
  const listFilter = $derived(!channel || category === null ? null : category === 'favourites' ? 'favourites' : `category:${category}`);
  /** The category's guide: where ▦ Guide goes, and Back without history. */
  const guideHref = $derived(category ? `/browse/live/${category}` : '/browse/live');
  // Switching channel within the category keeps its name while the new channel's answer is on its way.
  const listLabel = $derived(
    context && (context.itemId === itemId || (askedCategory !== null && context.asked === askedCategory)) ? (context.label ?? '') : '',
  );

  /** The list's channels in order, for channel up and down and "channel 4 of 85": loaded once per list, not per channel. */
  let loadedOrder = $state.raw<{ filter: string; ids: number[] } | null>(null);
  $effect(() => {
    const filter = listFilter;
    if (!filter) return;
    const ctl = new AbortController();
    loadChannelOrder(filter, ctl.signal).then(
      (ids) => (loadedOrder = { filter, ids }),
      () => {}, // without it, no channel up and down
    );
    return () => ctl.abort();
  });
  const order = $derived(loadedOrder && loadedOrder.filter === listFilter ? loadedOrder.ids : []);
  const where = $derived.by(() => {
    const at = order.indexOf(itemId);
    return at < 0 ? null : [listLabel, `channel ${at + 1} of ${order.length}`].filter(Boolean).join(' · ');
  });

  /** What follows the programme on now, fetched again whenever the item (and so its on-now line) is. */
  let next = $state.raw<{ itemId: number; programme: Programme | null } | null>(null);
  $effect(() => {
    const it = onNow.item;
    if (kind !== 'live' || !it || it.id !== itemId) return;
    const ctl = new AbortController();
    const from = Math.floor(Date.now() / 1000);
    const after = it.now?.stopSec ?? from;
    programmes([it.id], from, from + NEXT_WINDOW_SEC, ctl.signal).then(
      (found) => {
        const upcoming = (found[it.id] ?? []).filter((p) => p.startSec >= after).sort((a, b) => a.startSec - b.startSec);
        next = { itemId: it.id, programme: upcoming[0] ?? null };
      },
      () => {},
    );
    return () => ctl.abort();
  });
  const nextLabel = $derived.by(() => {
    const p = next?.itemId === itemId ? next.programme : null;
    return p ? `Next · ${formatClock(p.startSec)} ${p.title}` : undefined;
  });

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
    if (live && neighbour(order, it.id, -1) !== null) actions.previoustrack = () => switchChannel(-1);
    if (live && neighbour(order, it.id, 1) !== null) actions.nexttrack = () => switchChannel(1);
    const artist = live ? onNow.onNow?.title : params.catchup?.title || undefined;
    setNowPlaying({ title: it.displayName, artist, artworkUrl: it.logoUrl ?? undefined }, actions);
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
    const p = params;
    const mine = begun;
    const play = (k: Kind) => {
      if (mine !== begun || !video) return;
      const catchup = p.catchup ? { startSec: p.catchup.startSec, stopSec: p.catchup.stopSec } : undefined;
      void playback.start({ kind: k, itemId: p.itemId, episodeRemoteId: p.episode ?? undefined, startAtSec, catchup }, video);
    };
    const known = kindNow(p);
    if (known) return play(known);
    // An item that can't be fetched still plays, as a movie: its seeks restart the session, which a channel ignores.
    void onNow.load(p.itemId).then((it) => play(it?.kind === 'live' ? 'live' : 'movie'));
  }

  /** Tap to restart: a movie, episode or catch-up programme carries on from where it was. */
  function restart() {
    start(playback.isVod() && video ? playback.absoluteSec(video) : 0);
  }

  /** Starts playback for the current URL: catch-up, an explicit time, the resume prompt, or from the top. */
  function begin() {
    const mine = ++begun;
    if (!video) return;
    const p = params;
    durationSec = null;
    void onNow.load(p.itemId);
    if (p.catchup) return start(0);
    if (p.t) return start(p.t);
    if (kindNow(p) === 'live') return start(0); // nothing to resume
    view = { kind: 'starting' };
    positions(p.itemId).then(
      (saved) => {
        if (mine !== begun) return;
        const best = pickResume(saved, p.episode);
        if (best) view = { kind: 'resume', atSec: best.positionSec };
        else start(0);
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
    void goto(watchHref(id, { category, catchup: now }));
  }

  /** "● Watch live": this channel, live. */
  function watchLive() {
    void goto(watchHref(itemId, { category }));
  }

  /** Channel up or down, in the list's order. The playing session is released as the next one starts. */
  function switchChannel(dir: -1 | 1) {
    const id = neighbour(order, itemId, dir);
    if (id !== null) void goto(watchHref(id, { category }));
  }

  function openGuide() {
    void goto(guideHref);
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

  afterNavigate((nav) => {
    if (nav.from) inAppHistory = true;
  });

  /** Back where you came from. Opened from outside the app (a bookmark, a link, a relaunch), to the list it belongs to. */
  function back() {
    if (inAppHistory) return history.back();
    let home = guideHref;
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
    if (view && view.kind !== 'resume') view = null;
  }

  function onPlay() {
    if (view?.kind === 'tapToPlay') view = null;
  }

  /** A stream the element can't play. One that dies with a stopped or refused session has nothing new to say. */
  function onVideoError() {
    if (view === null || view.kind === 'starting' || view.kind === 'tapToPlay') view = { kind: 'error' };
  }

  const actions = $derived.by(() => {
    const list: WatchAction[] = [];
    if (channel) list.push({ key: 'favourite', icon: '★', label: 'Favourite', pressed: isFavourite, run: toggleFavourite });
    if (kind === 'live' && onNow.onNow && (onNow.item?.catchupDays ?? 0) > 0) {
      list.push({ key: 'from-start', icon: '↺', label: 'From start', run: fromStart });
    }
    if (kind === 'catchup') list.push({ key: 'watch-live', icon: '●', label: 'Watch live', run: watchLive });
    if (channel) list.push({ key: 'guide', icon: '▦', label: 'Guide', run: openGuide });
    if (caps.pip) list.push({ key: 'pip', icon: '⧉', label: 'Picture in picture', run: pip });
    if (caps.airplay) list.push({ key: 'airplay', icon: '⎚', label: 'AirPlay', run: airplay });
    // Sideways already fills the screen.
    if (!orientation.landscape) list.push({ key: 'fullscreen', icon: '⤢', label: 'Full screen', run: toggleFullscreen });
    return list;
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
    <button type="button" class="back" onclick={back}>‹ Back</button>
  </header>

  <div class="player">
    <video bind:this={video} playsinline autoplay onplay={onPlay} onplaying={onPlaying} onerror={onVideoError}></video>
    {#if player}
      <!-- Catch-up positions count from the programme's start, so its bar is the VOD one. -->
      <PlayerControls
        state={player}
        mode={kind === 'live' ? 'live' : 'vod'}
        title={name}
        subtitle={kind === 'catchup' ? params.catchup?.title || undefined : kind === 'live' ? onNow.onNow?.title : undefined}
        nextLabel={kind === 'live' ? nextLabel : undefined}
        {fullscreen}
        programme={kind === 'live' ? onNow.onNow : null}
        {liveShiftSec}
        {caps}
        tracks={{ audio: false, subtitles: false }}
        durationSec={barSec}
        holding={moreOpen}
        covered={view !== null}
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
        onTracks={() => {}}
        onBack={back}
      />
    {/if}
    {#if view}
      <PlayerStates
        {view}
        {name}
        artwork={onNow.item?.logoUrl ?? null}
        poster={kind === 'movie' || kind === 'episode'}
        onResume={resume}
        onStartOver={() => start(0)}
        onRestart={restart}
        onPlay={tapToPlay}
      />
    {/if}
  </div>

  <WatchInfo {kind} item={onNow.item} onNow={onNow.onNow} catchup={params.catchup} {where} next={nextLabel} />
  <WatchActions {actions} bind:moreOpen />

  {#if listFilter}
    <!-- Something to switch to: the category's channels, the playing one highlighted. A row plays it live. -->
    <section class="switch" aria-label="Channels">
      <div class="lhead">
        <strong>{listLabel}</strong>
        {#if order.length > 0}<span>{order.length} {order.length === 1 ? 'channel' : 'channels'}</span>{/if}
      </div>
      <NowList filter={listFilter} label={listLabel} currentItemId={itemId} />
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
