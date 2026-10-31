/**
 * How a service type (a branch's "vertical") is named and coloured wherever it is shown.
 *
 * Kept in one place because it is shown in two: the Service Type manager, where the list is
 * maintained, and the Vertical picker on the branch form, where one is chosen. Those two
 * screens are opened within a click of each other from the same toolbar, so a type that is
 * blue on one and pink on the other reads as two different things.
 *
 * The lead forms' Department is a service type too, so its list is read from here as well.
 */
import { useEffect, useState } from "react";
import { getVerticals } from "@/lib/api";

// What the Service Type manager shows on a database with none stored. Also the list a
// Department dropdown falls back to when the fetch fails, so the form can still be filed.
export const DEFAULT_SERVICE_TYPES = ["offline_physiotherapy", "online_physiotherapy", "online_fitness", "offline_fitness_gym"];

/**
 * The service type names Branch Manager > Service Type holds, in its order.
 *
 * Read fresh each time a form mounts rather than cached, so a type added there is offered on
 * the next Add New Lead without a reload.
 */
export const useServiceTypes = () => {
  const [names, setNames] = useState([]);
  useEffect(() => {
    let alive = true;
    getVerticals()
      .then((rows) => {
        const stored = (rows || []).map((r) => r.name).filter(Boolean);
        if (alive) setNames(stored.length ? stored : DEFAULT_SERVICE_TYPES);
      })
      .catch((e) => {
        console.warn("[load failed]", e?.message || e);
        if (alive) setNames(DEFAULT_SERVICE_TYPES);
      });
    return () => { alive = false; };
  }, []);
  return names;
};

/** Online or offline, read off the name's prefix -- the same test as isOnlineVertical on the
 *  branch boards, so a lead and a branch of one type agree about which side they are on. */
export const isOnlineServiceType = (name) => String(name || "").startsWith("online_");

// The OS's chip palette — blue, green, amber, violet, rose, cyan.
export const SERVICE_TYPE_COLORS = ["#2563eb", "#059669", "#d97706", "#7c3aed", "#e11d48", "#0891b2"];

/**
 * The colour for a service type, from its own name.
 *
 * Off the name rather than its position in the list, which is what this replaced. A branch
 * form's Vertical picker shows only the types matching Online or Offline, so the same type
 * sits at a different index there than in the full list on the Service Type screen — and an
 * index-coloured chip changed colour between the two, or when a type was added above it.
 *
 * The hash only has to be stable and spread, not unguessable.
 */
export const serviceTypeColor = (name) => {
  const s = String(name || "");
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 100000;
  return SERVICE_TYPE_COLORS[h % SERVICE_TYPE_COLORS.length];
};

/**
 * "offline_physiotherapy" -> "offline physiotherapy". Only the underscores go: the casing is
 * left to CSS so the chips can carry the OS's small-caps treatment, and what gets read back
 * for a match is still the stored name.
 */
export const serviceTypeLabel = (name) => String(name || "").replace(/_/g, " ");

/**
 * "offline_physiotherapy" -> "Offline Physiotherapy", for a dropdown or a detail row, where
 * the type is read as a name rather than worn as a chip. Only a stored slug is re-cased: a
 * lead imported off a sheet can carry free text in Department, and that keeps its own words.
 */
export const serviceTypeTitle = (name) => {
  const s = String(name || "");
  return /^[a-z0-9_]+$/.test(s) ? serviceTypeLabel(s).replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s;
};

/** The tile styles a chip wears, so the manager and the picker cannot drift apart. */
export const serviceTypeChipStyle = (color) => ({
  tile: { backgroundColor: `${color}0f`, borderColor: `${color}33` },
  glyph: { backgroundColor: `${color}24` },
  icon: { color },
});
