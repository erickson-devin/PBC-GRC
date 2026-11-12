/**
 * The system use notice version this tab's user acknowledged before signing in (issue #256). Memory only: never written to storage,
 * so closing the tab, reloading or opening the sign-in page again shows the notice again. The sign-in calls send it as `systemUseAck`;
 * the session lock screen's password sign-in reuses it. Reset when the sign-in page's gate mounts and on sign-out.
 */
let acknowledged: number | null = null;

export function acknowledgeSystemUseNotice(version: number): void {
  acknowledged = version;
}

export function acknowledgedSystemUseNotice(): number | null {
  return acknowledged;
}

export function resetSystemUseNoticeAck(): void {
  acknowledged = null;
}
