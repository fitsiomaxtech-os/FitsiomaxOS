import { useEffect, useState } from "react";
import { getTherapistSign } from "@/lib/api";
import { signSrc } from "@/lib/signImage";

/**
 * The sign over a Consultation Form's Therapist Name, as a data URL, or "".
 *
 * `saved` ({ name, image }) is the one the form was saved with, kept for as long as it names
 * the same therapist. Any other name is looked up once the typing pauses; which names have a
 * sign at this branch is the server's to say.
 */
export const useTherapistSign = (branchId, name, saved) => {
  const typed = String(name || "").trim();
  const kept = saved?.image && saved.name === typed ? signSrc(saved.image) : "";
  const [found, setFound] = useState({ name: "", image: "" });

  useEffect(() => {
    if (!branchId || !typed || kept) return undefined;
    let live = true;
    const t = setTimeout(() => {
      getTherapistSign(branchId, typed)
        .then((r) => { if (live) setFound({ name: typed, image: signSrc(r?.image) }); })
        .catch(() => {}); // unsigned, to sign by hand
    }, 500);
    return () => { live = false; clearTimeout(t); };
  }, [branchId, typed, kept]);

  return kept || (typed && found.name === typed ? found.image : "");
};
