import { useEffect, useState } from "react";
import { UserCircle } from "lucide-react";

/**
 * An employee's face where there is one, their initial where there is not.
 *
 * One component for the directory, the record, the form and the signed-in header, so a
 * photo cannot appear in some of those and not others, and so the fallback is the same
 * shape as the photo — a row of avatars that changed size depending on who had uploaded
 * one would read as broken layout rather than as missing pictures.
 *
 * Lives here rather than in HRBoard because HR is no longer the only board that shows a
 * face: the header shows whoever is signed in, and a second copy of this would be a
 * second set of rules about what happens when the file is missing.
 */
export const EmployeeAvatar = ({
  employee,
  size = 40,
  className = "",
  // The tint the initial sits in where there is no photo. A prop rather than something a
  // caller appends to `className`, because two Tailwind background utilities on one
  // element are settled by the stylesheet's order and not by the order they are written
  // in — a caller "overriding" bg-slate-100 that way would work or not depending on the
  // build. Boards that colour experts in their own hue (the booking popup's CONSULTANT
  // column is teal) pass theirs; everywhere else keeps the neutral default.
  fallbackClassName = "bg-slate-100 text-slate-500",
}) => {
  // Reset on the employee changing, not just on error: a failed load left the fallback
  // showing for whoever was rendered into the same slot next.
  const [failed, setFailed] = useState(false);
  const url = employee?.photo_url || "";
  useEffect(() => { setFailed(false); }, [url]);

  const box = { width: size, height: size };
  if (!url || failed) {
    return (
      <div
        className={`flex shrink-0 items-center justify-center rounded-full font-semibold uppercase ${fallbackClassName} ${className}`}
        style={{ ...box, fontSize: Math.max(11, Math.round(size * 0.4)) }}
        aria-hidden="true"
      >
        {(employee?.full_name || "?").trim().charAt(0) || "?"}
      </div>
    );
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-full object-cover ${className}`}
      style={box}
    />
  );
};

/**
 * The My Profile button on a phone's bottom bar: the signed-in person's own photo once
 * they have set one, the outline glyph until then.
 *
 * Not EmployeeAvatar's initial as the fallback: on a bar of outline glyphs a lettered disc
 * reads as a different kind of button, and the glyph is what the bar has always shown
 * there. The ring is drawn in the button's text colour, so the photo lights up with the
 * rest of the bar when Profile is the open tab. `user` is App's copy of the login, which
 * My Profile's upload updates in place, so the bar changes the moment the photo is saved.
 */
export const ProfileNavGlyph = ({ user, size = 24, iconClassName = "h-5 w-5" }) => {
  const [failed, setFailed] = useState(false);
  const url = user?.photo_url || "";
  useEffect(() => { setFailed(false); }, [url]);

  if (!url || failed) return <UserCircle className={`flex-none ${iconClassName}`} />;
  return (
    <img
      src={url}
      alt=""
      onError={() => setFailed(true)}
      className="flex-none rounded-full object-cover ring-2 ring-current"
      style={{ width: size, height: size }}
    />
  );
};

export default EmployeeAvatar;
