"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * false while rendering on the server and during hydration, true afterwards.
 * React uses the server snapshot during hydration and re-renders with the
 * client snapshot once hydration is done, so there is never a mismatch.
 */
function useIsClient(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

/** Same output on every machine: fixed locale, 24-hour clock, UTC. */
const UTC_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

/**
 * A timestamp in the viewer's own time zone and locale.
 *
 * The server and the browser usually differ in both (a host in UTC, a viewer
 * in India: "06:06:43 PM" vs "11:36:43 pm"), so formatting with the default
 * locale during server rendering causes a hydration mismatch. Server render
 * and hydration therefore print a deterministic UTC time; right after
 * hydration it switches to local time. The exact instant is always in the
 * dateTime attribute and the hover title.
 */
export function LocalTime({ iso }: { iso: string | null | undefined }) {
  const isClient = useIsClient();
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const text = isClient ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : `${UTC_TIME.format(date)} UTC`;
  return (
    <time dateTime={date.toISOString()} title={date.toISOString()}>
      {text}
    </time>
  );
}
