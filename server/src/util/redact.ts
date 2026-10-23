/** Masks Xtream credentials (query params and /live|movie|series|timeshift/user/pass/ paths) so a URL is safe to log. */
export function redactUrl(url: string): string {
  return url
    .replace(/([?&](?:username|password)=)[^&#]*/gi, '$1***')
    .replace(/(\/(?:live|movie|series|timeshift)\/)[^/?#]+\/[^/?#]+(?=\/)/gi, '$1***/***');
}
