import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Stethoscope, CalendarRange, Pill, Dumbbell, ShoppingCart, Activity, Plus, X, FlaskConical, Pencil, Trash2, ImagePlus, Wifi, MapPin, Clock, Eye, History, Salad, ChevronDown, RefreshCw, ClipboardList, HeartPulse, Music2, GraduationCap, Home, Truck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/sonner";
import { uploadStoreImage, createStoreItem, updateStoreItem, deleteStoreItem, listStoreItems, getPaymentHistory, getFollowUpHistory, getLoginHistory, getBranches } from "@/lib/api";
import { CONSULTATION_PACKAGES, consultationPackageByKey } from "@/lib/consultationPackages";
import { StoreInventoryPanel } from "@/components/branch/StoreInventoryPanel";
import { VendorPanel } from "@/components/branch/VendorPanel";
import { TreatmentTypesBoard } from "@/components/TreatmentTypesBoard";
import { PhysioTypesBoard } from "@/components/PhysioTypesBoard";

export const TABS = [
  { key: "consultations", label: "Consultations", icon: Stethoscope },
  { key: "sessions", label: "Sessions", icon: CalendarRange },
  // Four more programmes sold the same way a session package is — same create form, same
  // per-session pricing — each with its own catalogue rather than a sub-tab of Sessions,
  // because that is the shelf a branch browses them from. Zumba and Home Visit are offline
  // only; the other two sell both ways (see MODE_TAB_KEYS).
  //
  // Fitness is not among them. It is reached from Sessions > Fitness, the sub-tab that
  // always wrote this catalogue, and a top-level tab beside it was a second door onto one
  // shelf — two places showing the same rows and no way to tell that from two shelves
  // that happened to agree. The category is untouched: only the door is gone.
  { key: "rehab", label: "Rehab", icon: HeartPulse },
  { key: "zumba", label: "Zumba Class", icon: Music2 },
  { key: "workshop", label: "Workshop", icon: GraduationCap },
  { key: "home_visit", label: "Home Visit", icon: Home },
  // Both diet products, one sub-tab each — see DIET_SUBTABS.
  { key: "diet", label: "Diet Details", icon: Salad },
  { key: "tablet", label: "Tablet", icon: Pill },
  { key: "supplementary", label: "Supplementary", icon: FlaskConical },
  { key: "equipment", label: "Equipment", icon: Dumbbell },
  { key: "vending_machine", label: "Vending Machine", icon: ShoppingCart },
  // Beside the three stock shelves because it is read with them: a vendor is who the
  // tablets, supplements and equipment came from, and their supply list is built out of
  // the deliveries booked against them on those shelves.
  { key: "vendor", label: "Vendor", icon: Truck },
  // Moved in from its own top-level nav tab — the treatment catalogue belongs beside the
  // other things Super Admin catalogues here, not among Dashboard/HR/Branches.
  { key: "treatment", label: "Treatments", icon: ClipboardList },
  // Beside Treatments, and after it, because the two are read together: a Treatment is
  // what is wrong with the patient, a Physiotherapy Treatment is what is sold to them.
  { key: "physio_type", label: "Physiotherapy Treatment", icon: Activity },
  { key: "history", label: "History", icon: History },
];

export const CONSULTATIONS_SUBTABS = [
  { key: "physiotherapy", label: "Physiotherapy", icon: Activity },
  { key: "fitness", label: "Fitness", icon: Dumbbell },
];

// Diet Details — the two diet products, each the price one fee is collected at. The Diet
// Consultation Fee is quoted off the first shelf and the Diet Chart Fee off the second
// (DIET_FEE_KINDS in ConsultationsBoard.jsx, and the two collect routes in
// v3_packages.py), so which sub-tab a product is priced under is what decides which fee
// it is.
//
// item_type "diet" is the bookable Diet Consultation, priced and timed exactly like a
// physio consultation (v3_store.py validates it against the same duration rules) — it sat
// under Consultations until both diet products were brought together here. item_type
// "diet_package" is the Diet Chart: a plain priced product, no booking slot, no duration.
export const DIET_SUBTABS = [
  { key: "consultation", label: "Diet Consultation", kind: "diet", icon: Salad },
  { key: "chart", label: "Diet Chart", kind: "diet_package", icon: ClipboardList },
];

// Each of these is a category the session form already writes to, reached from under
// Sessions as well as from its own top-level tab. Rehab and Fitness are the same shelf in
// both places, deliberately: one catalogue read from wherever it is looked for, rather
// than a second one beside it holding different rows.
export const SESSIONS_SUBTABS = [
  { key: "physiotherapy", label: "Physiotherapy", icon: Activity },
  { key: "fitness", label: "Fitness", icon: Dumbbell },
  { key: "rehab", label: "Rehab", icon: HeartPulse },
];

export const PlaceholderPanel = ({ label, testid }) => (
  <Card data-testid={testid}>
    <CardContent className="p-8 text-center text-sm text-slate-400">
      {label} panel — setup coming soon.
    </CardContent>
  </Card>
);

const DEFAULT_PRICE_ONLINE = 1200;
const DEFAULT_PRICE_OFFLINE = 800;

export const DURATION_OPTIONS = [
  { minutes: 15, label: "15 mins" },
  { minutes: 30, label: "30 mins" },
  { minutes: 45, label: "45 mins" },
  { minutes: 60, label: "1 hour" },
  { minutes: 120, label: "2 hours" },
];

// ---------- Physiotherapy consultation packages ----------
//
// The Physiotherapy consultation shelf is sold as one of three packages rather than named
// freely, and each one's length follows from what is in it — so the package is picked and
// the duration is read off it, not chosen.
//
// The table lives in lib/consultationPackages so this screen and the Consultation Fee desk
// — which picks one of these when the money is taken — read the same list without either
// importing the other. See that file for how it relates to the server's copy.
//
// Only Physiotherapy. Fitness and the Diet Consultation name themselves and pick their own
// duration, as they always have.
const packageByKey = consultationPackageByKey;

/**
 * What one item's length should read as, anywhere it is listed.
 *
 * Whatever duration was set on the item, packaged or not, falling back to the raw minutes
 * for a length that is not on the buttons.
 */
export const itemDurationLabel = (item) => {
  const minutes = item?.duration_minutes;
  return DURATION_OPTIONS.find((d) => d.minutes === minutes)?.label || `${minutes} mins`;
};

// ---------- Package artwork ----------
//
// The form asks for a 1080 x 1080 square, so anything larger is carrying pixels this OS
// will never draw. A photo straight off a phone is several megabytes of them, and the web
// server in front of the API caps a request body long before the API's own 5MB check ever
// runs — nginx's client_max_body_size, 1MB by default. It refuses with a bare 413 and an
// HTML page, so there is no `detail` to read and the failure arrives as "Failed to update"
// with nothing said about why.
//
// Shrinking first means the request is a couple of hundred kilobytes and the question does
// not come up. The 413 handling below stays anyway, for the file that will not shrink.
const IMAGE_EDGE = 1080;
const IMAGE_QUALITY = 0.85;
const LEAVE_ALONE_UNDER = 300 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // matches MAX_UPLOAD_BYTES in v3_store.py
const IMAGE_TYPES = /\.(jpe?g|png|webp)$/i;

const readableSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const shrinkImage = (file) => new Promise((resolve) => {
  if (!String(file.type || "").startsWith("image/")) return resolve(file);
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const longest = Math.max(img.width, img.height);
    const scale = Math.min(1, IMAGE_EDGE / (longest || 1));
    // Already the right size and already small: re-encoding would only lose detail.
    if (scale === 1 && file.size <= LEAVE_ALONE_UNDER) return resolve(file);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        // Whichever is smaller. Re-encoding an already-optimised PNG can come out bigger,
        // and sending the larger one would be worse than having done nothing.
        if (!blob || blob.size >= file.size) return resolve(file);
        // Renamed because it is a JPEG now, and the server checks the extension.
        const base = (file.name || "package").replace(/\.[^.]+$/, "");
        resolve(new File([blob], `${base}.jpg`, { type: "image/jpeg" }));
      },
      "image/jpeg",
      IMAGE_QUALITY,
    );
  };
  // A format the browser cannot decode (HEIC off an iPhone, say) goes up as it is and is
  // judged by the server's own extension check.
  img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
  img.src = url;
});

/** Upload the artwork, shrunk first, saying what actually went wrong if it will not go. */
const uploadPackageImage = async (file) => {
  const ready = await shrinkImage(file);
  if (ready.size > MAX_IMAGE_BYTES) {
    throw new Error(`That image is ${readableSize(ready.size)} even after shrinking. Pick one under 5 MB.`);
  }
  try {
    return await uploadStoreImage(ready);
  } catch (err) {
    // A 413 never reaches the API, so it carries no detail of its own to report.
    if (err?.response?.status === 413) {
      throw new Error(`The server refused the image at ${readableSize(ready.size)} — its upload limit is lower than this file. Try a smaller picture, or raise nginx client_max_body_size.`);
    }
    throw err;
  }
};

/**
 * The artwork on a package, and the two things that can be done to one already there.
 *
 * Picking a file and taking the image off are different answers and have to stay different
 * all the way to the payload: removed has to be written as null, where "left alone" has to
 * send the stored URL back untouched. Reading it off the preview instead — an image if
 * there is one, nothing if there is not — is what would make a package's artwork
 * permanent, since a blank preview and an unchanged one look identical from there.
 */
const usePackageImage = (item) => {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(item?.image_url || null);
  const [cleared, setCleared] = useState(false);
  // Only previews this hook made are ours to revoke; the item's own URL belongs to the
  // server and revoking it would blank the thumbnail everywhere else on the page.
  const objectUrl = useRef(null);
  useEffect(() => () => { if (objectUrl.current) URL.revokeObjectURL(objectUrl.current); }, []);

  const showPreview = (next) => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = next;
    setPreview(next);
  };

  const pick = (e) => {
    const chosen = e.target.files?.[0];
    // Cancelling the file dialog is not a removal. It arrives here as an empty list, and
    // treating that as "no image" would strip the artwork off a package by opening a
    // picker and thinking better of it.
    if (!chosen) return;
    // Refused here rather than after a round trip: the server checks the extension and
    // would only say the same thing a second later, having carried the file to say it.
    if (!IMAGE_TYPES.test(chosen.name || "")) {
      toast.error("Only JPG, PNG or WEBP images can be used here");
      e.target.value = "";
      return;
    }
    setFile(chosen);
    setCleared(false);
    showPreview(URL.createObjectURL(chosen));
    // Cleared so that picking the same file twice still fires a change event — without it,
    // removing an image and choosing it again leaves the field looking empty.
    e.target.value = "";
  };

  const clear = () => {
    setFile(null);
    setCleared(true);
    showPreview(null);
  };

  // What to save. Nothing is uploaded unless a file was actually chosen, so taking an
  // image off costs no round trip, and neither does saving a package nobody retouched.
  const resolve = async () => {
    if (file) return (await uploadPackageImage(file)).url;
    return cleared ? null : (item?.image_url || null);
  };

  return { preview, pick, clear, resolve };
};

/**
 * The image field: the dropzone, and Change and Remove beside it once there is something
 * to change or remove.
 *
 * Both controls sit outside the dropzone rather than on top of it. A button inside a
 * button is not valid markup and the browser is entitled to fire either one, and on a
 * 96px square an overlaid control is a target hit by accident about as often as on
 * purpose — which on Remove means losing artwork while trying to replace it.
 *
 * One field for every popup that carries a picture, so a consultation and a session
 * package cannot end up offering different things to do with the same picture.
 */
const PackageImageField = ({ image, testidPrefix }) => {
  const fileInputRef = useRef(null);
  const open = () => fileInputRef.current?.click();
  return (
    <div>
      <label className="mb-1 block text-xs font-semibold text-slate-600">
        Image <span className="font-normal text-slate-400">(Square, 1080 x 1080px)</span>
      </label>
      <div className="flex items-end gap-3">
        <button
          type="button"
          onClick={open}
          className="relative aspect-square w-24 shrink-0 overflow-hidden rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 transition hover:border-sky-400 hover:bg-sky-50/60"
          title={image.preview ? "Choose a different image" : "Add an image"}
          data-testid={`${testidPrefix}-image-dropzone`}
        >
          {image.preview ? (
            <img src={image.preview} alt="preview" className="h-full w-full object-cover" data-testid={`${testidPrefix}-image-preview`} />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center">
              <ImagePlus className="h-6 w-6 text-slate-400" />
              <span className="text-[11px] font-semibold text-slate-500">1080 x 1080</span>
              <span className="text-[10px] text-slate-400">(1:1 ratio)</span>
            </div>
          )}
        </button>
        {/* Nothing to act on until there is an image, and two buttons offering to change
            and remove one that is not there is a pair of dead controls. */}
        {image.preview && (
          <div className="flex flex-col gap-1.5" data-testid={`${testidPrefix}-image-actions`}>
            <button
              type="button"
              onClick={open}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600 transition hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700"
              data-testid={`${testidPrefix}-image-change`}
            >
              <Pencil className="h-3 w-3" />Change
            </button>
            <button
              type="button"
              onClick={image.clear}
              className="inline-flex items-center gap-1 rounded-md border border-rose-200 bg-white px-2 py-1 text-[11px] font-semibold text-rose-600 transition hover:bg-rose-50"
              data-testid={`${testidPrefix}-image-remove`}
            >
              <Trash2 className="h-3 w-3" />Remove
            </button>
          </div>
        )}
      </div>
      {/* Removal takes effect on Save, like every other field in these forms. Said out
          loud because the thumbnail disappears immediately and that reads as done. */}
      {image.preview === null && (
        <p className="mt-1.5 text-[10px] text-slate-400" data-testid={`${testidPrefix}-image-hint`}>
          Saved without an image unless you pick one.
        </p>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={image.pick}
        data-testid={`${testidPrefix}-image`}
        className="hidden"
      />
    </div>
  );
};

/** What went wrong, in the words of whoever knows: the API's own message, else ours, else
    the status. Anything is better than a bare "Failed to update", which was what a 413 and
    a dropped connection both looked like. */
const saveError = (err, verb) => (
  err?.response?.data?.detail
  || err?.message
  || (err?.response?.status ? `${verb} failed (HTTP ${err.response.status})` : `${verb} failed`)
);

const PriceFields = ({ priceOnline, setPriceOnline, priceOffline, setPriceOffline, onlineTestId, offlineTestId }) => (
  <div className="grid grid-cols-2 gap-2">
    <div>
      <label className="mb-1 flex items-center gap-1 text-xs font-semibold text-slate-600"><Wifi className="h-3 w-3 text-emerald-600" />Online Price</label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">₹</span>
        <Input type="number" min="0" value={priceOnline} onChange={(e) => setPriceOnline(e.target.value)} className="pl-7" data-testid={onlineTestId} />
      </div>
    </div>
    <div>
      <label className="mb-1 flex items-center gap-1 text-xs font-semibold text-slate-600"><MapPin className="h-3 w-3 text-amber-600" />Offline Price</label>
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">₹</span>
        <Input type="number" min="0" value={priceOffline} onChange={(e) => setPriceOffline(e.target.value)} className="pl-7" data-testid={offlineTestId} />
      </div>
    </div>
  </div>
);

// Diet Consultation is priced and timed exactly like a physio consultation, so it reuses
// the same panel and the same modal. Only the wording, the item_type and the header colour
// differ — a second copy of 200 lines would drift the moment one of them was edited.
const PACKAGE_KINDS = {
  consultation: {
    itemType: "consultation",
    noun: "Consultation",
    header: "from-sky-500 to-indigo-600",
    durationLabel: "Consultation Duration",
    emptyText: "No consultations yet. Click Create to add one.",
  },
  diet: {
    itemType: "diet",
    noun: "Diet Consultation",
    header: "from-emerald-500 to-teal-600",
    durationLabel: "Diet Consultation Duration",
    emptyText: "No diet consultations yet. Click Create to add one.",
    // A diet consultation costs the same wherever it is delivered — the consultation is
    // the same conversation on a screen or in a room. One field instead of two, written to
    // both stored prices so the booking path, which still picks price_online or
    // price_offline off the chosen mode, gets the same number either way.
    singlePrice: true,
  },
  // The Diet Chart, under Diet Details > Diet Chart — a plain priced item (name,
  // description, image, price), no booking slot. Its price is what the Diet Chart Fee is
  // collected at. Still item_type "diet_package" on the server, from when this shelf was
  // the Diet Package tab; sharing one item_type between "a diet chart for sale" and "a
  // bookable consultation slot" was the thing forcing a Duration field onto a product that
  // has no duration.
  diet_package: {
    itemType: "diet_package",
    noun: "Diet Chart",
    header: "from-emerald-500 to-teal-600",
    emptyText: "No diet charts yet. Click Create to add one.",
    singlePrice: true,
    noDuration: true,
  },
};

// The sentinel for "this row keeps the name it already has". An item created before the
// packages existed is not one of the three, and opening it to change its price must not
// quietly rename it to whichever package happened to sort first.
const KEEP_EXISTING_NAME = "__existing__";

// Exported for Branch Admin's FITSIO STORE, which opens it to edit a consultation, a diet
// consultation or a diet chart.
// branchId: set when editing from a branch's own store, so with Services and Products per
// branch switched On the edit is that branch's alone (the server decides; see v3_store.py).
export const CreateConsultationModal = ({ item, onClose, onSaved, kind = "consultation", category = "physiotherapy", branchId }) => {
  const cfg = PACKAGE_KINDS[kind] || PACKAGE_KINDS.consultation;
  const isEdit = Boolean(item);
  // Only the Physiotherapy consultation shelf is sold as fixed packages — see
  // CONSULTATION_PACKAGES. Everything else still types a name and picks a duration.
  const usesPackages = cfg.itemType === "consultation" && category === "physiotherapy";
  const [name, setName] = useState(item?.name || "");
  // Which package this is. A saved key wins; failing that an older row whose name happens
  // to read as one of the labels is recognised as that package, so the shelf converges as
  // rows are edited rather than needing a migration. Anything else keeps its own name.
  const [pkgKey, setPkgKey] = useState(() => {
    if (!usesPackages) return "";
    if (item?.consultation_package && packageByKey(item.consultation_package)) return item.consultation_package;
    if (item) return (CONSULTATION_PACKAGES.find((p) => p.label === item.name) || {}).key || KEEP_EXISTING_NAME;
    return CONSULTATION_PACKAGES[0].key;
  });
  const [description, setDescription] = useState(item?.description || "");
  const [priceOnline, setPriceOnline] = useState(item?.price_online ?? DEFAULT_PRICE_ONLINE);
  const [priceOffline, setPriceOffline] = useState(item?.price_offline ?? DEFAULT_PRICE_OFFLINE);
  const [duration, setDuration] = useState(() => {
    if (item?.duration_minutes) return item.duration_minutes;
    // A packaged consultation's length is typed in, not assumed from the package.
    return usesPackages ? "" : 30;
  });
  const image = usePackageImage(item);
  const [saving, setSaving] = useState(false);

  const chosenPackage = usesPackages ? packageByKey(pkgKey) : null;
  // A packaged row is named by its package and timed by whatever is typed in. Everything
  // else is named and timed by the two fields.
  const effectiveName = chosenPackage ? chosenPackage.label : name;
  const effectiveDuration = Number(duration) || 0;

  const submit = async () => {
    if (!effectiveName.trim()) { toast.error(`${cfg.noun} name is required`); return; }
    if (chosenPackage && !effectiveDuration) { toast.error("Enter the consultation duration"); return; }
    if (chosenPackage && (effectiveDuration < 5 || effectiveDuration > 480)) {
      toast.error("Duration must be between 5 and 480 minutes");
      return;
    }
    setSaving(true);
    try {
      const image_url = await image.resolve();
      // Both prices carry the one figure when the kind is single-priced. Sending only
      // price_online would leave an offline booking reading zero.
      const online = Number(priceOnline) || 0;
      const offline = cfg.singlePrice ? online : (Number(priceOffline) || 0);
      const payload = {
        item_type: cfg.itemType,
        category,
        name: effectiveName.trim(),
        description,
        image_url,
        price_online: online,
        price_offline: offline,
        duration_minutes: effectiveDuration,
        // Null on a row keeping its own name, which also clears the key off a packaged
        // row that was moved back to a free name.
        consultation_package: chosenPackage ? chosenPackage.key : null,
      };
      if (isEdit) {
        await updateStoreItem(item.id, payload, branchId);
        toast.success(`${cfg.noun} updated`);
      } else {
        await createStoreItem(payload);
        toast.success(`${cfg.noun} created`);
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(saveError(err, isEdit ? "Update" : "Create"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="consultation-create-modal">
      <div className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className={`flex shrink-0 items-center justify-between bg-gradient-to-r ${cfg.header} px-5 py-3 text-white`}>
          <p className="text-base font-semibold">{isEdit ? `Edit ${cfg.noun}` : cfg.noun}</p>
          <button onClick={onClose} className="rounded-full p-1.5 text-white/80 hover:bg-white/20" data-testid="consultation-create-close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">
              {usesPackages ? "Package" : "Name"}
            </label>
            {usesPackages ? (
              <select
                value={pkgKey}
                onChange={(e) => setPkgKey(e.target.value)}
                className="h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
                data-testid="consultation-create-package"
              >
                {/* Only ever offered to a row that already has a name of its own, and
                    listed first because it is the one it is currently on. */}
                {pkgKey === KEEP_EXISTING_NAME && (
                  <option value={KEEP_EXISTING_NAME}>{item?.name} (existing name)</option>
                )}
                {CONSULTATION_PACKAGES.map((p) => (
                  <option key={p.key} value={p.key}>{p.label}</option>
                ))}
              </select>
            ) : (
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Initial Physiotherapy Assessment" data-testid="consultation-create-name" />
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Description</label>
            <textarea
              rows={2}
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
              placeholder="Describe this consultation..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="consultation-create-description"
            />
          </div>
          <PackageImageField image={image} testidPrefix="consultation-create" />
          {/* A packaged consultation's length is typed in here. */}
          {!cfg.noDuration && chosenPackage ? (
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">{cfg.durationLabel}</label>
              <div className="rounded-md border border-sky-100 bg-sky-50 px-3 py-2" data-testid="consultation-create-duration-derived">
                <div className="flex items-center gap-2">
                  <Clock className="h-3.5 w-3.5 shrink-0 text-sky-900" />
                  <Input
                    type="number"
                    min={5}
                    max={480}
                    value={duration}
                    onChange={(e) => setDuration(e.target.value)}
                    className="h-8 w-24 bg-white text-sm font-bold text-sky-900"
                    data-testid="consultation-create-duration-minutes"
                  />
                  <span className="text-sm font-semibold text-sky-900">mins</span>
                </div>
              </div>
            </div>
          ) : !cfg.noDuration && (
            <div>
              <label className="mb-1 block text-xs font-semibold text-slate-600">{cfg.durationLabel}</label>
              <div className="flex flex-wrap gap-2" data-testid="consultation-create-duration">
                {DURATION_OPTIONS.map((d) => (
                  <button
                    key={d.minutes}
                    type="button"
                    onClick={() => setDuration(d.minutes)}
                    className={`rounded-md border px-3 py-1.5 text-sm font-medium ${duration === d.minutes ? "border-sky-500 bg-sky-50 text-sky-700" : "border-slate-200 text-slate-600"}`}
                    data-testid={`consultation-create-duration-${d.minutes}`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Price</label>
            {cfg.singlePrice ? (
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-500">₹</span>
                <Input
                  type="number"
                  value={priceOnline}
                  onChange={(e) => setPriceOnline(e.target.value)}
                  className="pl-7"
                  data-testid="consultation-create-price"
                />
              </div>
            ) : (
              <PriceFields
                priceOnline={priceOnline}
                setPriceOnline={setPriceOnline}
                priceOffline={priceOffline}
                setPriceOffline={setPriceOffline}
                onlineTestId="consultation-create-price-online"
                offlineTestId="consultation-create-price-offline"
              />
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/40 px-5 py-3">
          <Button variant="outline" onClick={onClose} data-testid="consultation-create-cancel">Cancel</Button>
          <Button onClick={submit} disabled={saving} className="bg-sky-600 text-white hover:bg-sky-700" data-testid="consultation-create-submit">
            {saving ? (isEdit ? "Saving..." : "Creating...") : (isEdit ? "Save Changes" : "Create")}
          </Button>
        </div>
      </div>
    </div>
  );
};

// A package's session count doesn't vary by Online vs Offline, only the per-session
// price does — no dropdown to configure it, it's fixed per catalogue.
const FIXED_SESSIONS = 7;

// Rehab and Fitness both run a longer course than the rest, so their shelves are fixed at
// their own length. Anything not named here keeps the standard count.
const FIXED_SESSIONS_BY_CATEGORY = { rehab: 26, fitness: 26, zumba: 12, home_visit_consultation: 1 };
const fixedSessionsFor = (category) => FIXED_SESSIONS_BY_CATEGORY[category] ?? FIXED_SESSIONS;

/**
 * Zumba is not sold as a bundle of loose classes but as a membership. The class runs
 * three days a week - Monday, Wednesday, Friday - which comes to 12 a month, and that
 * never varies. What a member picks is how many months they pay for up front.
 */
const ZUMBA_CLASSES_PER_MONTH = 12;
const ZUMBA_CLASS_DAYS = "Mon · Wed · Fri";
// The price on each term is where the box opens, not what the term must cost: Super Admin
// prices the shelf and a branch sells what was saved, so a membership renegotiated at the
// counter is typed over here rather than worked around by inventing another package.
const ZUMBA_PLANS = [
  { months: 1, label: "1 Month", price: 3000 },
  { months: 3, label: "3 Months", price: 9000 },
  { months: 6, label: "6 Months", price: 15000 },
  { months: 12, label: "1 Year", price: 30000 },
];
const zumbaSessionsFor = (months) => months * ZUMBA_CLASSES_PER_MONTH;
const formatRupees = (amount) => {
  const n = Number(amount) || 0;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
};

// What gets stored is still the per-session rate every session package stores, so
// assignment and collection keep charging rate x sessions and nothing downstream has to
// learn that some shelves are sold as a whole course. The course amount is what that rate
// was derived from, recovered here for display: neither 15000 / 72 nor 18000 / 26 divides
// evenly, so the total is rounded back to the price that was actually typed rather than
// shown as the rate multiplied out.
const packageTotalFrom = (rate, sessions) => Math.round((Number(rate) || 0) * (Number(sessions) || 0));

/**
 * What a package costs, in the terms its own shelf is priced in.
 *
 * A course shelf holds the whole fee as it was typed and it is read straight back — no
 * multiplying, so no chance of the card and the bill disagreeing about a figure somebody
 * negotiated. Every other shelf holds a rate and the total is that rate times the count.
 *
 * `price_is_total` comes off the item rather than being inferred from the category, so a
 * row the startup conversion has not reached yet is still read the way it was written.
 */
const packageTotal = (item, mode) => {
  const price = mode === "online" ? item?.price_online : item?.price_offline;
  if (item?.price_is_total) return Number(price) || 0;
  const sessions = mode === "online" ? item?.sessions_online : item?.sessions_offline;
  return packageTotalFrom(price, sessions);
};

/**
 * Shelves priced as a whole course rather than per session.
 *
 * Rehab is sold as one 26-session programme at one price — what a buyer agrees is the
 * course, not a rate — so the form takes that figure and keeps it. Typed, saved, shown and
 * charged as the same number, with no arithmetic anywhere between the box and the bill.
 *
 * It used to divide the total down and multiply it back out. That returned the right
 * figure, but the catalogue then held 692.3076923076923 for an 18,000 course: a number
 * nobody agreed, that every screen had to be taught not to show, and that would have been
 * charged as the whole course by any reader that forgot to multiply.
 */
// Kept in step with PRICE_IS_TOTAL_CATEGORIES in backend/routers/v3_store.py, which marks
// what is written from here, and with migrate_course_prices_to_totals in seed.py, which
// converts what was written before. A shelf added to one and not the others reads its own
// prices two different ways.
const COURSE_TOTAL_CATEGORIES = new Set(["rehab", "fitness"]);

// Shelves with no online price to ask for. Group and Personal Training happen in the gym
// and a home visit happens at the customer's house: there is no version of either taken
// over video, so a second box asking what they cost online was a question with no answer,
// and a figure typed into it went to the store as a price somebody could be charged.
//
// The stored row still carries both prices -- the booking path picks one by mode, and a
// zero on the other reads as free -- so what is entered once is written to both.
const OFFLINE_ONLY_CATEGORIES = new Set(["fitness", "home_visit", "home_visit_consultation"]);

/**
 * Home Visit is split in two — a consultant coming to the house, and a physiotherapist
 * doing so — and each is sold as one package with one price. There is no online/offline
 * choice to make about somebody at your door, so neither the form nor the card mentions
 * a mode at all: one box, headed Home Visit.
 *
 * Physiotherapy keeps the plain "home_visit" category so the packages created before the
 * split still sit on it; Consultant is the new shelf beside it.
 */
export const HOME_VISIT_SUBTABS = [
  { key: "consultant", label: "Consultant", icon: Stethoscope, category: "home_visit_consultation", noun: "home visit consultation" },
  { key: "physiotherapy", label: "Physiotherapy", icon: Activity, category: "home_visit", noun: "home visit physiotherapy package" },
];
const HOME_VISIT_CATEGORIES = new Set(HOME_VISIT_SUBTABS.map((t) => t.category));
const COURSE_TOTAL_DEFAULTS = { rehab: { online: 14000, offline: 18000 } };

// Only a whole number of months is a plan. Anything else is a Zumba row saved before this
// existed, and calling it "1 Month" would contradict the class count printed beside it.
const zumbaMonthsFor = (sessions) => (
  sessions > 0 && sessions % ZUMBA_CLASSES_PER_MONTH === 0 ? sessions / ZUMBA_CLASSES_PER_MONTH : null
);

// Exported for Branch Admin's FITSIO STORE, which opens it to edit a session-shaped package.
export const CreateSessionPackageModal = ({ item, onClose, onSaved, category = "physiotherapy", branchId }) => {
  const isEdit = Boolean(item);
  const isZumba = category === "zumba";
  const isOfflineOnly = OFFLINE_ONLY_CATEGORIES.has(category);
  const isHomeVisit = HOME_VISIT_CATEGORIES.has(category);
  // Both Home Visit shelves. Consultant: typed in the Appointment popup. Physiotherapy:
  // typed on the Treatment Fee card once the Consultant has chosen the package.
  const canManualPrice = isHomeVisit;
  const [manualPrice, setManualPrice] = useState(Boolean(item?.manual_price));
  const isManual = canManualPrice && manualPrice;
  // Rehab and anything else sold as a whole course: the two price boxes hold the course
  // amount, not a per-session rate. What is stored is still the rate (see submit) — this is
  // only about which figure the person filling the form is asked for.
  const isCourseTotal = COURSE_TOTAL_CATEGORIES.has(category);
  // Zumba has two dials: how many months, and what those months cost. The term sets the
  // class count and seeds the amount from the shelf's own price list; the amount is then
  // editable, because the standard price is what a membership usually sells for rather
  // than the only figure it can ever be sold at.
  const [planMonths, setPlanMonths] = useState(
    () => zumbaMonthsFor(item?.sessions_offline || item?.sessions_online || 0) || ZUMBA_PLANS[0].months,
  );
  const zumbaPlan = ZUMBA_PLANS.find((p) => p.months === planMonths) || ZUMBA_PLANS[0];
  // One amount per term, so switching between them to compare does not overwrite a figure
  // typed against another, and switching back returns to what was entered.
  const [planPrices, setPlanPrices] = useState(() => {
    const seeded = Object.fromEntries(ZUMBA_PLANS.map((p) => [p.months, p.price]));
    // Editing: the row holds a per-class rate, so the figure actually typed is that rate
    // across the whole plan. Recovered here so the box opens on the amount that was agreed
    // rather than snapping back to the shelf default it was moved off.
    const savedMonths = zumbaMonthsFor(item?.sessions_offline || item?.sessions_online || 0);
    if (savedMonths) seeded[savedMonths] = packageTotal(item, "offline") || packageTotal(item, "online");
    return seeded;
  });
  const planPrice = planPrices[planMonths] ?? zumbaPlan.price;
  const setPlanPrice = (value) => setPlanPrices((prev) => ({ ...prev, [planMonths]: value }));
  const [name, setName] = useState(item?.name || "");
  const [description, setDescription] = useState(item?.description || "");
  // On a course-priced shelf these hold the course total, recovered from the stored rate
  // when editing so the box shows the figure that was typed rather than the rate behind it.
  const [priceOnline, setPriceOnline] = useState(() => {
    if (!isCourseTotal) return item?.price_online ?? DEFAULT_PRICE_ONLINE;
    if (item) return packageTotal(item, "online");
    return COURSE_TOTAL_DEFAULTS[category]?.online ?? DEFAULT_PRICE_ONLINE;
  });
  const [priceOffline, setPriceOffline] = useState(() => {
    if (!isCourseTotal) return item?.price_offline ?? DEFAULT_PRICE_OFFLINE;
    if (item) return packageTotal(item, "offline");
    return COURSE_TOTAL_DEFAULTS[category]?.offline ?? DEFAULT_PRICE_OFFLINE;
  });
  const image = usePackageImage(item);
  const [saving, setSaving] = useState(false);

  // How many sessions the package contains. Seeded from the saved package when editing,
  // from the shelf's default when creating, and editable from there.
  //
  // It used to be a const with no input behind it, so a package was stuck for life with
  // the count it was created at — a 12-session course could only ever be built by creating
  // a new package and deleting the old one. Seeding still never recalculates from the
  // catalogue default, so opening an old package to fix a price does not quietly relabel
  // it as a course of a different length; it now just lets that length be changed on
  // purpose.
  //
  // Zumba is the exception and stays derived: its length *is* the plan, so the months
  // picker sets the class count and an editable box beside it would be a second, arguing
  // source for the same number.
  const [sessionCount, setSessionCount] = useState(
    () => item?.sessions_online || item?.sessions_offline || fixedSessionsFor(category),
  );
  const sessions = isZumba ? zumbaSessionsFor(planMonths) : Math.max(0, Number(sessionCount) || 0);
  const perClass = sessions > 0 ? (Number(planPrice) || 0) / sessions : 0;
  // A course shelf's box holds the fee itself; everywhere else the total is the rate
  // multiplied out.
  const totalOnline = isCourseTotal ? (Number(priceOnline) || 0) : (Number(priceOnline) || 0) * sessions;
  const totalOffline = isCourseTotal ? (Number(priceOffline) || 0) : (Number(priceOffline) || 0) * sessions;

  const submit = async () => {
    if (!name.trim()) { toast.error("Package name is required"); return; }
    // Refused rather than saved as zero: a package of no sessions prices every course at
    // nothing on a course shelf, and on a per-session shelf it sells a course nobody can
    // attend. Both are worse than being asked for a number.
    if (!isZumba && !(sessions > 0)) { toast.error("Sessions must be at least 1"); return; }
    // The membership amount is the whole of what gets charged, so an empty or zero box
    // here sells a term for nothing rather than at a discount.
    if (isZumba && !(Number(planPrice) > 0)) { toast.error("Plan amount must be more than 0"); return; }
    setSaving(true);
    try {
      const image_url = await image.resolve();
      const payload = {
        item_type: "session",
        category,
        name: name.trim(),
        description,
        image_url,
        // Zumba runs offline only, but both prices are written all the same - the booking
        // path picks one by mode, and leaving the other at zero would read as free. Its
        // membership is still divided down to a per-class rate, because what a member buys
        // is a number of months and the class count follows from that.
        //
        // A course shelf is entered by hand and saved exactly as typed. It used to be
        // divided by the session count and multiplied back out on the way to the bill,
        // which returned the right figure but meant the catalogue held 1,200 for a 31,200
        // course — a number nobody had agreed and every reader had to be taught to hide.
        price_online: isZumba ? perClass : isManual ? 0 : (Number(isOfflineOnly ? priceOffline : priceOnline) || 0),
        price_offline: isZumba ? perClass : isManual ? 0 : (Number(priceOffline) || 0),
        sessions_online: sessions,
        sessions_offline: sessions,
        manual_price: isManual,
      };
      if (isEdit) {
        await updateStoreItem(item.id, payload, branchId);
        toast.success("Session package updated");
      } else {
        await createStoreItem(payload);
        toast.success("Session package created");
      }
      onSaved();
      onClose();
    } catch (err) {
      toast.error(saveError(err, isEdit ? "Update" : "Create"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="session-create-modal">
      <div className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex shrink-0 items-center justify-between bg-gradient-to-r from-sky-500 to-indigo-600 px-5 py-3 text-white">
          <p className="text-base font-semibold">{`${isEdit ? "Edit" : "Add"} ${isZumba ? "Zumba Membership" : isHomeVisit ? "Home Visit Package" : "Session Package"}`}</p>
          <button onClick={onClose} className="rounded-full p-1.5 text-white/80 hover:bg-white/20" data-testid="session-create-close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Package Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Enter package name" data-testid="session-create-name" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">Description</label>
            <textarea
              rows={2}
              maxLength={250}
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-sky-400 focus:outline-none focus:ring-1 focus:ring-sky-400"
              placeholder="Enter package description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="session-create-description"
            />
            <p className="mt-0.5 text-right text-[10px] text-slate-400">{description.length}/250</p>
          </div>
          <PackageImageField image={image} testidPrefix="session-create" />

          {isZumba ? (
          <div data-testid="zumba-plan-setup">
            <label className="mb-1 block text-xs font-semibold text-slate-600">Membership Plan</label>
            <div className="flex flex-wrap gap-2" data-testid="zumba-plan-options">
              {ZUMBA_PLANS.map((plan) => (
                <button
                  key={plan.months}
                  type="button"
                  onClick={() => setPlanMonths(plan.months)}
                  className={`rounded-lg border px-3 py-2 text-sm font-semibold transition ${planMonths === plan.months ? "border-violet-300 bg-violet-50 text-violet-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
                  data-testid={`zumba-plan-${plan.months}m`}
                >
                  {plan.label}<span className="ml-1.5 text-xs font-normal opacity-70">₹{formatRupees(planPrices[plan.months] ?? plan.price)}</span>
                </button>
              ))}
            </div>
            <div className="mt-2 rounded-lg border border-violet-100 bg-violet-50/60 p-3">
              <p className="mb-2 flex items-center gap-1 text-xs font-bold text-violet-800"><CalendarRange className="h-3 w-3" />Class Schedule</p>
              <div className="space-y-1 text-[11px] text-violet-800">
                <div className="flex items-center justify-between"><span>Days</span><span className="font-bold">{ZUMBA_CLASS_DAYS}</span></div>
                <div className="flex items-center justify-between"><span>Classes a month</span><span className="font-bold">{ZUMBA_CLASSES_PER_MONTH}</span></div>
                <div className="flex items-center justify-between"><span>Total classes</span><span className="font-bold" data-testid="zumba-plan-sessions">{sessions}</span></div>
                {/* Typed, seeded from the term. Picking a term fills this in with what the
                    shelf normally charges for it; overwriting it prices this membership at
                    what was agreed, and the per class rate below follows the box. */}
                <div className="flex items-center justify-between gap-2">
                  <span>Plan amount</span>
                  <div className="relative w-28">
                    <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-violet-600">₹</span>
                    <Input
                      type="number"
                      min="0"
                      value={planPrice}
                      onChange={(e) => setPlanPrice(e.target.value)}
                      className="h-7 border-violet-200 bg-white pl-5 text-right text-xs font-bold text-violet-900"
                      data-testid="zumba-plan-price"
                    />
                  </div>
                </div>
              </div>
              <div className="mt-2 flex items-center justify-between border-t border-violet-200 pt-1.5">
                <span className="text-[11px] font-semibold text-violet-700">Per Class</span>
                <span className="text-sm font-extrabold text-violet-900" data-testid="zumba-plan-per-class">₹{formatRupees(perClass)}</span>
              </div>
            </div>
          </div>
          ) : (
          <div>
            <label className="mb-1 block text-xs font-semibold text-slate-600">
              {isHomeVisit ? "Package Setup" : isOfflineOnly ? "Offline Setup" : "Online & Offline Setup"}
            </label>
            <div className={`grid gap-2 ${isOfflineOnly ? "grid-cols-1" : "grid-cols-2"}`} data-testid="session-create-mode-boxes">
              {!isOfflineOnly && (
              <div className="rounded-lg border border-emerald-100 bg-emerald-50/60 p-3">
                <p className="mb-2 flex items-center gap-1 text-xs font-bold text-emerald-800"><Wifi className="h-3 w-3" />Online Mode</p>
                {/* The box asks for whatever that shelf is actually sold in — the whole
                    course on Rehab, a rate everywhere else. Asking for the rate on a
                    course-priced shelf is what made 18,000 unreachable. */}
                <label className="mb-0.5 block text-[10px] font-semibold text-emerald-700">{isCourseTotal ? `Amount for ${sessions} Sessions` : "Per Session Amount"}</label>
                <div className="relative mb-2">
                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-emerald-600">₹</span>
                  <Input type="number" min="0" value={priceOnline} onChange={(e) => setPriceOnline(e.target.value)} className="h-8 pl-6 text-sm" data-testid="session-create-price-online" />
                </div>
                <label className="mb-0.5 block text-[10px] font-semibold text-emerald-700">Sessions</label>
                {/* One count behind both boxes — submit writes the same number to
                    sessions_online and sessions_offline, so two independent inputs would be
                    two ways to set one stored value. Editing either moves both. */}
                <Input
                  type="number"
                  min="1"
                  value={sessions}
                  onChange={(e) => setSessionCount(e.target.value)}
                  readOnly={isZumba}
                  disabled={isZumba}
                  title={isZumba ? "Set by the plan above" : undefined}
                  className={`h-8 text-sm ${isZumba ? "bg-emerald-50" : ""}`}
                  data-testid="session-create-sessions-online"
                />
                {/* No footer on a course shelf: the box above already holds the amount and
                    the label says what it covers. The per-session figure that used to sit
                    here is the total divided down for the booking path — an internal
                    number, and printing it invites reading it as the fee. */}
                {!isCourseTotal && (
                  <div className="mt-2 flex items-center justify-between border-t border-emerald-200 pt-1.5">
                    <span className="text-[11px] font-semibold text-emerald-700">Total Amount</span>
                    <span className="text-sm font-extrabold text-emerald-900" data-testid="session-create-total-online">₹{totalOnline}</span>
                  </div>
                )}
              </div>
              )}
              <div className="rounded-lg border border-amber-100 bg-amber-50/60 p-3">
                <p className="mb-2 flex items-center gap-1 text-xs font-bold text-amber-800">
                  {isHomeVisit ? <><Home className="h-3 w-3" />Home Visit</> : <><MapPin className="h-3 w-3" />Offline Mode</>}
                </p>
                {canManualPrice && (
                  <label className="mb-2 flex cursor-pointer items-start gap-2 rounded-md border border-amber-200 bg-white px-2.5 py-2 text-[11px] text-amber-900" data-testid="session-create-manual-price">
                    <input type="checkbox" className="mt-0.5" checked={manualPrice} onChange={(e) => setManualPrice(e.target.checked)} />
                    <span>
                      <span className="block font-semibold">Branch Admin enters the amount</span>
                      <span className="block text-amber-700">No fixed price — the Branch Admin types it, e.g. a Distance visit.</span>
                    </span>
                  </label>
                )}
                {isManual ? (
                  <p className="mb-2 rounded-md bg-amber-100/70 px-2.5 py-2 text-[11px] font-semibold text-amber-800" data-testid="session-create-manual-note">
                    Amount: set by the Branch Admin
                  </p>
                ) : (
                <>
                <label className="mb-0.5 block text-[10px] font-semibold text-amber-700">{isCourseTotal ? `Amount for ${sessions} Sessions` : isHomeVisit ? "Per Visit Amount" : "Per Session Amount"}</label>
                <div className="relative mb-2">
                  <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-amber-600">₹</span>
                  <Input type="number" min="0" value={priceOffline} onChange={(e) => setPriceOffline(e.target.value)} className="h-8 pl-6 text-sm" data-testid="session-create-price-offline" />
                </div>
                </>
                )}
                <label className="mb-0.5 block text-[10px] font-semibold text-amber-700">{isHomeVisit ? "Visits" : "Sessions"}</label>
                {/* One count behind both boxes — submit writes the same number to
                    sessions_online and sessions_offline, so two independent inputs would be
                    two ways to set one stored value. Editing either moves both. */}
                <Input
                  type="number"
                  min="1"
                  value={sessions}
                  onChange={(e) => setSessionCount(e.target.value)}
                  readOnly={isZumba}
                  disabled={isZumba}
                  title={isZumba ? "Set by the plan above" : undefined}
                  className={`h-8 text-sm ${isZumba ? "bg-amber-50" : ""}`}
                  data-testid="session-create-sessions-offline"
                />
{!isCourseTotal && !isManual && (
                  <div className="mt-2 flex items-center justify-between border-t border-amber-200 pt-1.5">
                    <span className="text-[11px] font-semibold text-amber-700">Total Amount</span>
                    <span className="text-sm font-extrabold text-amber-900" data-testid="session-create-total-offline">₹{totalOffline}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
          )}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/40 px-5 py-3">
          <Button variant="outline" onClick={onClose} data-testid="session-create-cancel">Cancel</Button>
          <Button onClick={submit} disabled={saving} className="bg-sky-600 text-white hover:bg-sky-700" data-testid="session-create-submit">
            {saving ? (isEdit ? "Saving..." : "Creating...") : (isEdit ? "Save Changes" : "Save Package")}
          </Button>
        </div>
      </div>
    </div>
  );
};

/**
 * Online and Offline prices side by side — unless the item is single-priced, in which
 * case one figure. A diet package stores the same number in both fields, and showing it
 * twice under two different labels invites the reader to look for a difference that is
 * not there and contradicts a form that offered one box.
 */
// mode: "all" | "offline" | "online" — defaults to "all" so BranchStoreBoard.jsx's own
// call (which never passes it) keeps showing both, exactly as before. Super Admin's
// Services page passes its own All/Offline/Online pill selection through here, since an
// Offline Branch Admin only ever needs this item's offline price and an Online one only
// the online price.
export const PriceModeBadges = ({ item, isSession, mode = "all" }) => (
  item.item_type === "diet" || item.item_type === "diet_package" ? (
    <div className="mt-2">
      <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-2.5 py-1.5">
        <span className="text-xs font-bold text-emerald-800">Price</span>
        <span className="text-sm font-extrabold text-emerald-900">₹{item.price_online ?? 0}</span>
      </div>
    </div>
  ) : (
  <div className="mt-2 space-y-1.5">
    {mode !== "offline" && (
      <div className="flex items-center justify-between rounded-lg bg-emerald-50 px-2.5 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-800">
          <Wifi className="h-3.5 w-3.5" />Online
        </span>
        <span className="text-sm font-extrabold text-emerald-900">
          ₹{isSession ? packageTotal(item, "online") : (item.price_online ?? 0)}
        </span>
      </div>
    )}
    {mode !== "online" && (
      <div className="flex items-center justify-between rounded-lg bg-amber-50 px-2.5 py-1.5">
        <span className="inline-flex items-center gap-1.5 text-xs font-bold text-amber-800">
          <MapPin className="h-3.5 w-3.5" />Offline
        </span>
        <span className="text-sm font-extrabold text-amber-900">
          ₹{isSession ? packageTotal(item, "offline") : (item.price_offline ?? 0)}
        </span>
      </div>
    )}
  </div>
  )
);

// Same mode convention as PriceModeBadges — "all" (default) keeps both boxes, exactly
// what every existing caller (ViewItemModal, BranchStoreBoard) still gets since neither
// passes it.
export const SessionPriceBoxes = ({ item, testid, mode = "all" }) => {
  // A Zumba row is a membership: the schedule is fixed and the money that changes hands is
  // the plan amount, so the per-session pair every other package shows would be reading out
  // an internal figure. Offline only, so one box either way.
  if (item.category === "zumba") {
    const classes = item.sessions_offline || item.sessions_online || 0;
    const months = zumbaMonthsFor(classes);
    return (
      <div className="rounded-xl border border-violet-100 bg-violet-50/60 p-3" data-testid={testid}>
        <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-violet-800">
          <Music2 className="h-3.5 w-3.5" />{months ? `${months} Month${months > 1 ? "s" : ""} Plan` : "Zumba Class"}
        </p>
        <div className="space-y-1.5 text-xs text-violet-800">
          <div className="flex items-center justify-between"><span>Days</span><span className="font-bold">{ZUMBA_CLASS_DAYS}</span></div>
          <div className="flex items-center justify-between">
            <span>Classes</span>
            <span className="font-bold">{months ? `${ZUMBA_CLASSES_PER_MONTH}/month · ${classes} total` : `${classes} total`}</span>
          </div>
          <div className="mt-1 flex items-center justify-between border-t border-violet-200 pt-1.5">
            <span className="font-semibold">Plan Amount</span>
            <span className="text-sm font-extrabold text-violet-900">₹{packageTotalFrom(item.price_offline ?? item.price_online, classes)}</span>
          </div>
        </div>
      </div>
    );
  }
  // A course-priced shelf shows the amount and the length, and no per-session line. That
  // figure is the total divided down for the booking path to charge on — an internal
  // number, not a price anybody set — and printing it here invites reading it as the fee.
  // Same reason the Zumba card above shows a plan amount rather than a per-class rate.
  const courseOnly = COURSE_TOTAL_CATEGORIES.has(item.category);
  // A shelf sold only in the room shows one box. Both prices are stored -- the booking path
  // reads one by mode -- so an Online box here would print the same figure again under a
  // heading for a thing that is not sold, which reads as two prices to choose between.
  const offlineOnly = OFFLINE_ONLY_CATEGORIES.has(item.category);
  const showOnline = mode !== "offline" && !offlineOnly;
  // The one box such a shelf has is the offline one, so the Online filter has to keep it.
  // Hiding it there left both boxes suppressed at once and the card printed a package with
  // no price on it at all — a figure that exists, is charged, and had nowhere to appear.
  //
  // It says "At the gym" rather than "Offline Mode", which is the same answer the Online
  // filter needs: this is sold in the room, and here is what it costs.
  const showOffline = mode !== "online" || offlineOnly;
  const homeVisit = HOME_VISIT_CATEGORIES.has(item.category);
  const manual = homeVisit && Boolean(item.manual_price);
  return (
  <div className={`grid gap-2 ${mode === "all" && !offlineOnly ? "grid-cols-2" : "grid-cols-1"}`} data-testid={testid}>
    {showOnline && (
      <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-emerald-800"><Wifi className="h-3.5 w-3.5" />Online Mode</p>
        <div className="space-y-1.5 text-xs text-emerald-800">
          {!courseOnly && <div className="flex items-center justify-between"><span>Per Session</span><span className="font-bold">₹{item.price_online ?? 0}</span></div>}
          <div className="flex items-center justify-between"><span>Total Sessions</span><span className="font-bold">{item.sessions_online ?? 0} Sessions</span></div>
          <div className="mt-1 flex items-center justify-between border-t border-emerald-200 pt-1.5">
            <span className="font-semibold">Total Amount</span>
            <span className="text-sm font-extrabold text-emerald-900">₹{packageTotal(item, "online")}</span>
          </div>
        </div>
      </div>
    )}
    {showOffline && (
      <div className="rounded-xl border border-amber-100 bg-amber-50/60 p-3">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-amber-800">
          {homeVisit ? <Home className="h-3.5 w-3.5" /> : <MapPin className="h-3.5 w-3.5" />}{homeVisit ? "Home Visit" : offlineOnly ? "At the gym" : "Offline Mode"}
        </p>
        <div className="space-y-1.5 text-xs text-amber-800">
          {!courseOnly && !manual && <div className="flex items-center justify-between"><span>{homeVisit ? "Per Visit" : "Per Session"}</span><span className="font-bold">₹{item.price_offline ?? 0}</span></div>}
          <div className="flex items-center justify-between"><span>{homeVisit ? "Total Visits" : "Total Sessions"}</span><span className="font-bold">{item.sessions_offline ?? 0} {homeVisit ? "Visits" : "Sessions"}</span></div>
          <div className="mt-1 flex items-center justify-between border-t border-amber-200 pt-1.5">
            <span className="font-semibold">Total Amount</span>
            {manual
              ? <span className="text-xs font-bold text-amber-900" data-testid={testid ? `${testid}-manual` : undefined}>Set by Branch Admin</span>
              : <span className="text-sm font-extrabold text-amber-900">₹{packageTotal(item, "offline")}</span>}
          </div>
        </div>
      </div>
    )}
  </div>
  );
};

export const ViewItemModal = ({ item, kind, onClose, onEdit, canEdit = true }) => {
  const isSession = kind === "session";
  // Sessions are not a PACKAGE_KINDS entry — they carry a session count, not a duration —
  // so this falls back rather than assuming every kind has one.
  const viewCfg = PACKAGE_KINDS[kind] || PACKAGE_KINDS.consultation;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} data-testid="item-view-modal">
      <div className="flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className={`flex shrink-0 items-center justify-between bg-gradient-to-r ${viewCfg.header} px-5 py-3 text-white`}>
          <p className="flex-1 truncate text-base font-semibold" data-testid="item-view-name">{item.name}</p>
          <div className="flex shrink-0 items-center gap-1">
            {canEdit && (
              <button onClick={onEdit} className="rounded-full p-1.5 text-white/80 hover:bg-white/20" data-testid="item-view-edit" title="Edit">
                <Pencil className="h-4 w-4" />
              </button>
            )}
            <button onClick={onClose} className="rounded-full p-1.5 text-white/80 hover:bg-white/20" data-testid="item-view-close" title="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          {item.image_url && <img src={item.image_url} alt={item.name} className="h-48 w-full rounded-lg object-cover" />}
          {item.description && <p className="text-sm text-slate-600">{item.description}</p>}

          {isSession ? (
            <SessionPriceBoxes item={item} testid="item-view-session-boxes" />
          ) : (
            <div className="rounded-xl border border-slate-100 bg-slate-50/50 p-3">
              <PriceModeBadges item={item} isSession={false} />
              {!viewCfg.noDuration && item.duration_minutes && (
                <div className="mt-1.5 flex items-center justify-between rounded-lg bg-sky-50 px-2.5 py-1.5">
                  <span className="inline-flex items-center gap-1.5 text-xs font-bold text-sky-800">
                    <Clock className="h-3.5 w-3.5" />{viewCfg.durationLabel}
                  </span>
                  <span className="text-sm font-extrabold text-sky-900">
                    {itemDurationLabel(item)}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// Backs both Sessions sub-tabs; see PhysiotherapyPanel for why this is one component
// with a category rather than two copies.
const SessionsPhysiotherapyPanel = ({ category = "physiotherapy", reloadToken, toolbarSlot, modeFilter = "all", noun = "session package" }) => {
  const [items, setItems] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [viewingItem, setViewingItem] = useState(null);
  // A failed load used to be swallowed, which left the shelf reading as empty — the same
  // thing it says when there genuinely is nothing on it. Two different situations that
  // look identical is the one that gets acted on wrongly: somebody adds a package that
  // already exists because the list that would have shown it never arrived.
  const [loadError, setLoadError] = useState("");

  const loadItems = () => listStoreItems(category, "session")
    .then((rows) => { setItems(rows || []); setLoadError(""); })
    .catch((err) => setLoadError(err?.response?.data?.detail || "Could not load this shelf."));
  // category in the deps, or switching sub-tab keeps the other one's list on screen.
  useEffect(() => { loadItems(); }, [category, reloadToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDelete = async (it) => {
    if (!window.confirm(`Permanently delete "${it.name}"? This cannot be undone.`)) return;
    try {
      await deleteStoreItem(it.id);
      toast.success(`${noun.charAt(0).toUpperCase()}${noun.slice(1)} deleted permanently`);
      loadItems();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to delete");
    }
  };

  return (
    <div className="space-y-3" data-testid={`sessions-subpanel-${category}`}>
      {toolbarSlot && createPortal(
        <Button
          onClick={() => setShowCreate(true)}
          title={`Create ${noun}`}
          aria-label={`Create ${noun}`}
          className="h-11 w-11 shrink-0 p-0"
          data-testid={`sessions-${category}-create-btn-mobile`}
        >
          <Plus className="h-4 w-4" />
        </Button>,
        toolbarSlot,
      )}
      <div className="hidden items-center justify-end sm:flex">
        <Button size="sm" onClick={() => setShowCreate(true)} data-testid={`sessions-${category}-create-btn`}>
          <Plus className="mr-1 h-4 w-4" />Create
        </Button>
      </div>

      {loadError ? (
        <Card>
          <CardContent className="space-y-2 p-8 text-center text-sm">
            <p className="font-medium text-rose-600" data-testid={`sessions-${category}-load-error`}>{loadError}</p>
            <p className="text-xs text-slate-400">Nothing has been lost — this is the list failing to arrive, not an empty shelf.</p>
            <Button size="sm" variant="outline" onClick={loadItems}>Try again</Button>
          </CardContent>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-slate-400">
            No {noun}s yet. Click Create to add one.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid={`sessions-${category}-items-grid`}>
          {items.map((it) => (
            <Card key={it.id} data-testid={`session-item-${it.id}`}>
              <CardContent className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="flex-1 font-semibold text-slate-800">{it.name}</p>
                  <div className="flex shrink-0 gap-1">
                    <button
                      onClick={() => setViewingItem(it)}
                      className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-sky-600"
                      data-testid={`session-item-${it.id}-view`}
                      title="View"
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                    {/* Editing was reachable only by opening View first and pressing Edit
                        there, which is two clicks and a modal to correct a price. The View
                        route still works — this is the same dialog, one click sooner. */}
                    <button
                      onClick={() => setEditingItem(it)}
                      className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-sky-600"
                      data-testid={`session-item-${it.id}-edit`}
                      title="Edit"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(it)}
                      className="rounded-md p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600"
                      data-testid={`session-item-${it.id}-delete`}
                      title="Delete permanently"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {it.image_url && <img src={it.image_url} alt={it.name} className="h-[200px] w-full rounded-lg object-cover" />}
                {it.description && <p className="line-clamp-2 text-xs text-slate-500">{it.description}</p>}

                <SessionPriceBoxes item={it} mode={modeFilter} testid={`session-item-${it.id}-highlights`} />
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {showCreate && <CreateSessionPackageModal category={category} onClose={() => setShowCreate(false)} onSaved={loadItems} />}
      {editingItem && <CreateSessionPackageModal category={category} item={editingItem} onClose={() => setEditingItem(null)} onSaved={loadItems} />}
      {viewingItem && (
        <ViewItemModal
          item={viewingItem}
          kind="session"
          onClose={() => setViewingItem(null)}
          onEdit={() => { setEditingItem(viewingItem); setViewingItem(null); }}
        />
      )}
    </div>
  );
};

const SessionsPanel = ({ reloadToken, toolbarSlot, modeFilter = "all" }) => {
  const [sub, setSub] = useState("physiotherapy");
  return (
    <div className="space-y-4" data-testid="packages-panel-sessions">
      <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-1" data-testid="sessions-subtabs">
        {SESSIONS_SUBTABS.map((t) => {
          const Icon = t.icon;
          const active = sub === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setSub(t.key)}
              data-testid={`sessions-subtab-${t.key}`}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${active ? "bg-sky-50 text-sky-600" : "text-slate-600 hover:bg-slate-50"}`}
            >
              <Icon className="h-4 w-4" />{t.label}
            </button>
          );
        })}
      </div>

      {sub === "physiotherapy" && <SessionsPhysiotherapyPanel reloadToken={reloadToken} toolbarSlot={toolbarSlot} modeFilter={modeFilter} />}
      {sub === "fitness" && <SessionsPhysiotherapyPanel category="fitness" reloadToken={reloadToken} toolbarSlot={toolbarSlot} modeFilter={modeFilter} />}
      {/* Keyed, like the top-level shelves are: without it React keeps the panel instance
          across a sub-tab switch and the previous category's rows sit there until the new
          ones land. `noun` matches the Rehab tab's, so Create and the empty state say the
          same thing whichever way the shelf was reached. */}
      {sub === "rehab" && (
        <SessionsPhysiotherapyPanel
          key="rehab"
          category="rehab"
          noun="rehab package"
          reloadToken={reloadToken}
          toolbarSlot={toolbarSlot}
          modeFilter={modeFilter}
        />
      )}
    </div>
  );
};

/**
 * The consultation/diet catalogue for one category.
 *
 * Named for Physiotherapy because that is all it served at first; it now backs Fitness
 * too, which needs the identical panel against a different `category`. Parameterised
 * rather than copied — two hundred lines duplicated would drift the first time either
 * was edited, and the ask was explicitly for the same create option, not a new one.
 */
const PhysiotherapyPanel = ({ kind = "consultation", category = "physiotherapy", reloadToken, toolbarSlot, modeFilter = "all" }) => {
  const cfg = PACKAGE_KINDS[kind] || PACKAGE_KINDS.consultation;
  const [items, setItems] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [editingItem, setEditingItem] = useState(null);
  const [viewingItem, setViewingItem] = useState(null);

  const loadItems = () => listStoreItems(category, cfg.itemType).then(setItems).catch(() => {});
  // category in the deps, or switching sub-tab would show the other one's list until
  // something else happened to trigger a refetch.
  useEffect(() => { loadItems(); }, [cfg.itemType, category, reloadToken]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDelete = async (it) => {
    if (!window.confirm(`Permanently delete "${it.name}"? This cannot be undone.`)) return;
    try {
      await deleteStoreItem(it.id);
      toast.success(`${cfg.noun} deleted permanently`);
      loadItems();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to delete");
    }
  };

  return (
    <div className="space-y-3" data-testid={`consultations-subpanel-${category}`}>
      {/* Two Create buttons, one visible at a time. On a phone it belongs beside the tab
          dropdown and Refresh, which is a row this panel does not own — so it is portaled
          into a slot up there, and the slot itself is hidden from sm up. The labelled one
          below is desktop's, hidden under sm. Rendering both and letting CSS choose beats
          measuring the viewport in JS to decide which to mount. */}
      {toolbarSlot && createPortal(
        <Button
          onClick={() => setShowCreate(true)}
          title={`Create ${cfg.noun}`}
          aria-label={`Create ${cfg.noun}`}
          className="h-11 w-11 shrink-0 p-0"
          data-testid={`${category}-create-btn-mobile`}
        >
          <Plus className="h-4 w-4" />
        </Button>,
        toolbarSlot,
      )}
      <div className="hidden items-center justify-end sm:flex">
        <Button size="sm" onClick={() => setShowCreate(true)} data-testid={`${category}-create-btn`}>
          <Plus className="mr-1 h-4 w-4" />Create
        </Button>
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-slate-400">
            {cfg.emptyText}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid={`${category}-items-grid`}>
          {items.map((it) => (
            <Card key={it.id} data-testid={`consultation-item-${it.id}`}>
              <CardContent className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="flex-1 font-semibold text-slate-800">{it.name}</p>
                  <div className="flex shrink-0 gap-1">
                    <button
                      onClick={() => setViewingItem(it)}
                      className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 hover:text-sky-600"
                      data-testid={`consultation-item-${it.id}-view`}
                      title="View"
                    >
                      <Eye className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => handleDelete(it)}
                      className="rounded-md p-1.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600"
                      data-testid={`consultation-item-${it.id}-delete`}
                      title="Delete permanently"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {it.image_url && <img src={it.image_url} alt={it.name} className="h-[200px] w-full rounded-lg object-cover" />}
                {it.description && <p className="line-clamp-2 text-xs text-slate-500">{it.description}</p>}

                <div className="rounded-xl border border-slate-100 bg-slate-50/50 p-3" data-testid={`consultation-item-${it.id}-highlights`}>
                  <PriceModeBadges item={it} isSession={false} mode={modeFilter} />
                  {!cfg.noDuration && it.duration_minutes && (
                    <div className="mt-1.5 flex items-center justify-between rounded-lg bg-sky-50 px-2.5 py-1.5">
                      <span className="inline-flex items-center gap-1.5 text-xs font-bold text-sky-800">
                        <Clock className="h-3.5 w-3.5" />{cfg.durationLabel}
                      </span>
                      <span className="text-sm font-extrabold text-sky-900">
                        {itemDurationLabel(it)}
                      </span>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {showCreate && <CreateConsultationModal kind={kind} category={category} onClose={() => setShowCreate(false)} onSaved={loadItems} />}
      {editingItem && <CreateConsultationModal kind={kind} category={category} item={editingItem} onClose={() => setEditingItem(null)} onSaved={loadItems} />}
      {viewingItem && (
        <ViewItemModal
          item={viewingItem}
          kind={kind}
          onClose={() => setViewingItem(null)}
          onEdit={() => { setEditingItem(viewingItem); setViewingItem(null); }}
        />
      )}
    </div>
  );
};

const ConsultationsPanel = ({ reloadToken, toolbarSlot, modeFilter = "all" }) => {
  const [sub, setSub] = useState("physiotherapy");
  return (
    <div className="space-y-4" data-testid="packages-panel-consultations">
      <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-1" data-testid="consultations-subtabs">
        {CONSULTATIONS_SUBTABS.map((t) => {
          const Icon = t.icon;
          const active = sub === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setSub(t.key)}
              data-testid={`consultations-subtab-${t.key}`}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${active ? "bg-sky-50 text-sky-600" : "text-slate-600 hover:bg-slate-50"}`}
            >
              <Icon className="h-4 w-4" />{t.label}
            </button>
          );
        })}
      </div>

      {sub === "physiotherapy" && <PhysiotherapyPanel reloadToken={reloadToken} toolbarSlot={toolbarSlot} modeFilter={modeFilter} />}
      {sub === "fitness" && <PhysiotherapyPanel category="fitness" reloadToken={reloadToken} toolbarSlot={toolbarSlot} modeFilter={modeFilter} />}
    </div>
  );
};

// Diet Details: the Diet Consultation and the Diet Chart, a sub-tab each (DIET_SUBTABS).
// Keyed by kind so switching does not leave the other shelf's rows on screen while the new
// ones load.
const DietDetailsPanel = ({ reloadToken, toolbarSlot, modeFilter = "all" }) => {
  const [sub, setSub] = useState(DIET_SUBTABS[0].key);
  const current = DIET_SUBTABS.find((t) => t.key === sub) || DIET_SUBTABS[0];
  return (
    <div className="space-y-4" data-testid="packages-panel-diet">
      <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-1" data-testid="diet-subtabs">
        {DIET_SUBTABS.map((t) => {
          const Icon = t.icon;
          const active = sub === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setSub(t.key)}
              data-testid={`diet-subtab-${t.key}`}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${active ? "bg-sky-50 text-sky-600" : "text-slate-600 hover:bg-slate-50"}`}
            >
              <Icon className="h-4 w-4" />{t.label}
            </button>
          );
        })}
      </div>
      <PhysiotherapyPanel key={current.kind} kind={current.kind} reloadToken={reloadToken} toolbarSlot={toolbarSlot} modeFilter={modeFilter} />
    </div>
  );
};

// Home Visit's Consultant / Physiotherapy split. Each sub-tab is its own category on the
// session panel every other session-shaped shelf uses, keyed so switching does not leave
// the other sub-tab's rows on screen while the new ones load.
const HomeVisitPanel = ({ reloadToken, toolbarSlot, modeFilter = "all" }) => {
  const [sub, setSub] = useState(HOME_VISIT_SUBTABS[0].key);
  const current = HOME_VISIT_SUBTABS.find((t) => t.key === sub) || HOME_VISIT_SUBTABS[0];
  return (
    <div className="space-y-4" data-testid="packages-panel-home-visit">
      <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-1" data-testid="home-visit-subtabs">
        {HOME_VISIT_SUBTABS.map((t) => {
          const Icon = t.icon;
          const active = sub === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setSub(t.key)}
              data-testid={`home-visit-subtab-${t.key}`}
              className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${active ? "bg-sky-50 text-sky-600" : "text-slate-600 hover:bg-slate-50"}`}
            >
              <Icon className="h-4 w-4" />{t.label}
            </button>
          );
        })}
      </div>
      <SessionsPhysiotherapyPanel
        key={current.category}
        category={current.category}
        noun={current.noun}
        reloadToken={reloadToken}
        toolbarSlot={toolbarSlot}
        modeFilter={modeFilter}
      />
    </div>
  );
};

const HISTORY_ACTION_LABELS = {
  consultation_paid: "Consultation Sold",
  package_sold: "Package Sold",
  package_assigned: "Package Assigned",
  package_payment_collected: "Consultation Fee Collected",
  treatment_fee_collected: "Treatment Fee Collected",
  fee_collected: "Fee Collected",
  follow_up_scheduled: "Follow-Up Scheduled · Pre-Sales",
  follow_up_rescheduled: "Follow-Up Rescheduled · Pre-Sales",
  branch_follow_up_scheduled: "Follow-Up Scheduled · Branch",
  branch_follow_up_rescheduled: "Follow-Up Rescheduled · Branch",
  consultation_follow_up_scheduled: "Follow-Up Scheduled · Consultation",
  consultation_follow_up_rescheduled: "Follow-Up Rescheduled · Consultation",
};

const ActivityHistoryTable = ({ fetchFn, emptyLabel, testidPrefix, reloadToken }) => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    fetchFn(200)
      .then((res) => setRows(res.history || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [fetchFn, reloadToken]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-3" data-testid={`${testidPrefix}-panel`}>
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">{rows.length} entr{rows.length === 1 ? "y" : "ies"}</p>
        <Button size="sm" variant="outline" onClick={load} data-testid={`${testidPrefix}-refresh-btn`}>Refresh</Button>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-slate-400">
            {loading ? "Loading..." : emptyLabel}
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden border-slate-200">
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-left">Date</th>
                  <th className="px-4 py-2 text-left">Patient</th>
                  <th className="px-4 py-2 text-left">Branch</th>
                  <th className="px-4 py-2 text-left">Action</th>
                  <th className="px-4 py-2 text-left">Details</th>
                  <th className="px-4 py-2 text-left">By</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100" data-testid={`${testidPrefix}-row-${r.id}`}>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">{(r.created_at || "").replace("T", " ").slice(0, 16)}</td>
                    <td className="px-4 py-3 font-medium text-slate-800">{r.patient_name || "—"}</td>
                    <td className="px-4 py-3 text-slate-600">{r.branch_name || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="inline-flex items-center rounded-full bg-violet-50 px-2 py-0.5 text-xs font-semibold text-violet-700">
                        {HISTORY_ACTION_LABELS[r.action] || r.action}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">{r.details || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">{r.created_by || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

const LoginHistoryTable = ({ reloadToken }) => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    getLoginHistory(200)
      .then((res) => setRows(res.history || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [reloadToken]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-3" data-testid="login-history-panel">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">{rows.length} login{rows.length === 1 ? "" : "s"}</p>
        <Button size="sm" variant="outline" onClick={load} data-testid="login-history-refresh-btn">Refresh</Button>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-slate-400">
            {loading ? "Loading..." : "No logins recorded yet."}
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden border-slate-200">
          <CardContent className="overflow-x-auto p-0">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-2 text-left">Date &amp; Time</th>
                  <th className="px-4 py-2 text-left">User</th>
                  <th className="px-4 py-2 text-left">Role</th>
                  <th className="px-4 py-2 text-left">Branch</th>
                  <th className="px-4 py-2 text-left">Email</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100" data-testid={`login-history-row-${r.id}`}>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-slate-500">{(r.created_at || "").replace("T", " ").slice(0, 16)}</td>
                    <td className="px-4 py-3 font-medium text-slate-800">{r.user_name || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="inline-flex items-center rounded-full bg-sky-50 px-2 py-0.5 text-xs font-semibold capitalize text-sky-700">
                        {(r.role || "—").replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{r.branch_name || "—"}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{r.email || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
};

const HISTORY_SUBTABS = [
  { key: "payments", label: "Payment History" },
  { key: "followups", label: "Follow Up History" },
  { key: "logins", label: "Login Tracker" },
];

const HistoryPanel = ({ reloadToken }) => {
  const [sub, setSub] = useState("payments");
  return (
    <div className="space-y-3" data-testid="packages-panel-history">
      <div className="flex flex-wrap gap-2 rounded-lg border border-slate-200 bg-white p-1" data-testid="history-subtabs">
        {HISTORY_SUBTABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setSub(t.key)}
            data-testid={`history-subtab-${t.key}`}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${sub === t.key ? "bg-sky-50 text-sky-600" : "text-slate-600 hover:bg-slate-50"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {sub === "payments" && (
        <ActivityHistoryTable fetchFn={getPaymentHistory} emptyLabel="No payments collected yet." testidPrefix="payment-history" reloadToken={reloadToken} />
      )}
      {sub === "followups" && (
        <ActivityHistoryTable fetchFn={getFollowUpHistory} emptyLabel="No follow-ups scheduled yet." testidPrefix="followup-history" reloadToken={reloadToken} />
      )}
      {sub === "logins" && <LoginHistoryTable reloadToken={reloadToken} />}
    </div>
  );
};

// The three stock shelves. One panel serves all of them, told which by its category —
// the same panel Branch Admin uses, so the two stores cannot drift apart.
const INVENTORY_TABS = new Set(["tablet", "supplementary", "equipment"]);

// Which tabs have a panel. Everything else falls through to the placeholder; Vending
// Machine is the only one left, and it has no backend at all yet.
/**
 * The tabs that are a session package under another name: Rehab, Zumba Class, Fitness,
 * Workshop and Home Visit.
 *
 * Each is its own catalogue (`category`) sold through the session form, so Create on any of
 * them opens exactly what Sessions opens. `noun` only changes the wording on the empty
 * state and the button's title — the shelf, the form and the record are the same shape.
 *
 * Fitness is deliberately absent. It used to sit here pointing at the category the
 * Sessions > Fitness sub-tab already writes to, which kept the two from drifting but left
 * one shelf reachable from two tabs; the sub-tab is the one that stayed.
 */
const SESSION_LIKE_TABS = {
  rehab: { category: "rehab", noun: "rehab package" },
  zumba: { category: "zumba", noun: "Zumba class" },
  // Nothing in FIXED_SESSIONS_BY_CATEGORY, COURSE_TOTAL_CATEGORIES or
  // OFFLINE_ONLY_CATEGORIES names it, so a workshop takes the plain shape: the standard
  // session count, priced per session, with both an online and an offline price asked for.
  workshop: { category: "workshop", noun: "workshop" },
  // Home Visit is not here: it has Consultant and Physiotherapy sub-tabs of its own, so it
  // renders HomeVisitPanel instead (see HOME_VISIT_SUBTABS).
};

const BUILT_TABS = new Set(["consultations", "sessions", "rehab", "zumba", "workshop", "home_visit", "diet", "history", "treatment", "physio_type", "vendor", ...INVENTORY_TABS]);

// TABS above stays a flat, unbroken export — BranchStoreBoard.jsx imports and filters it
// for its own layout too, and reshaping it here would reshape that board's as well.
//
// Which catalogue tabs sit next to Consultations/Sessions depends on the mode picked
// below — the online/offline split of what a branch actually stocks. All is
// unrestricted (the full catalogue, Vending Machine included, since it isn't yet sorted
// into either mode); Offline drops Vending Machine; Online drops everything that only
// makes sense at a physical location (Tablet, Supplementary, Equipment, Vending Machine,
// and Vendor with them — there is nothing to buy in for a branch that holds no stock).
// Catalogue tabs only Super Admin maintains. They ride in MODE_TAB_KEYS because that is
// what decides which tabs a mode shows, but a branch has no business in them: the write
// endpoints are super_admin-only, so a branch would get a list it cannot add to and a
// button that 403s. BranchStoreBoard subtracts these.
//
// Treatments is deliberately not in here. It already shows in the branch store and has
// since it was built; taking it away is a change to what branches see today, and not
// one to make as a side effect of adding a neighbouring tab.
export const SUPER_ADMIN_CATALOGUE_TABS = new Set(["physio_type"]);

export const MODE_TAB_KEYS = {
  all: new Set(["consultations", "sessions", "rehab", "zumba", "workshop", "home_visit", "diet", "tablet", "supplementary", "equipment", "vending_machine", "vendor", "treatment", "physio_type"]),
  offline: new Set(["consultations", "sessions", "rehab", "zumba", "workshop", "home_visit", "diet", "tablet", "supplementary", "equipment", "vendor", "treatment", "physio_type"]),
  online: new Set(["consultations", "sessions", "rehab", "workshop", "diet", "treatment", "physio_type"]),
};

const MODE_FILTERS = [
  { key: "all", label: "All" },
  { key: "offline", label: "Offline" },
  { key: "online", label: "Online" },
];

/**
 * The stock shelves as Super Admin sees them.
 *
 * Stock is held per branch and Super Admin has no branch of their own, so a branch has to
 * be named before there is anything to show — every stock call refuses without one. The
 * picker is that choice, and nothing loads until it is made rather than the panel opening
 * on an error.
 *
 * The catalogue behind it is org-wide: a tablet added here is the same row every branch
 * sees, which is exactly why Super Admin needs this screen. Until now only Branch Admins
 * could add to that shared catalogue, so two branches spelling the same tablet differently
 * ended up with two rows that could never be transferred between them.
 */
/**
 * The branch picker, in the shape the finance boards' filter dropdowns use: a bordered
 * trigger that opens a panel of pill rows rather than a native select's system menu.
 *
 * Colourless on purpose. Those boards give each branch its own tint because colour is
 * carrying meaning there — it ties a row in the table to the branch that owns it. Here
 * there is one selection and nothing to tie it to, so a palette would be decoration that
 * reads as information. The selected row is marked by weight and a filled ground instead.
 */
const BranchSelect = ({ value, options, onChange, testId }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const onDocClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const current = options.find((o) => o.value === value);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-9 min-w-[190px] items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        data-testid={testId}
      >
        <span className="truncate">{current?.label || "-- choose a branch --"}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 opacity-60 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 max-h-64 min-w-[190px] space-y-1 overflow-y-auto rounded-md border border-slate-200 bg-white p-1.5 shadow-lg" data-testid={`${testId}-list`}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={`block w-full whitespace-nowrap rounded-md border px-3 py-1.5 text-left text-xs font-semibold ${
                o.value === value
                  ? "border-slate-300 bg-slate-100 text-slate-900"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              }`}
              data-testid={`${testId}-option-${o.value}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const SuperAdminInventoryPanel = ({ category, reloadToken }) => {
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState("");

  useEffect(() => {
    getBranches()
      .then((rows) => {
        setBranches(rows || []);
        // One branch is not a choice, so it is made here rather than asked for.
        if ((rows || []).length === 1) setBranchId(rows[0].id);
      })
      .catch(() => setBranches([]));
  }, []);

  return (
    <div className="space-y-3" data-testid={`packages-inventory-${category}`}>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-3">
        <label className="text-xs font-medium text-slate-600">Branch:</label>
        <BranchSelect
          value={branchId}
          onChange={setBranchId}
          options={[
            { value: "", label: "-- choose a branch --" },
            ...branches.map((b) => ({ value: b.id, label: b.branch_name || b.name || "Unnamed branch" })),
          ]}
          testId={`packages-inventory-branch-${category}`}
        />
        <span className="text-[11px] text-slate-400">
          Stock is held per branch. The catalogue itself is shared across all of them.
        </span>
      </div>

      {branchId ? (
        // Keyed on both: without it React keeps the same instance across a change and the
        // previous branch's or shelf's rows sit there until the new ones land.
        <StoreInventoryPanel key={`${category}-${branchId}`} category={category} branchId={branchId} reloadToken={reloadToken} />
      ) : (
        <Card>
          <CardContent className="p-8 text-center text-sm text-slate-400">
            {branches.length === 0 ? "No branches yet." : "Choose a branch to see its stock."}
          </CardContent>
        </Card>
      )}
    </div>
  );
};

export const PackagesBoard = () => {
  // All / Offline / Online — which of the catalogue tabs sit next to Consultations and
  // Sessions (MODE_TAB_KEYS), and, within Consultations/Sessions themselves, which of a
  // package's two prices its cards show. History sits outside this split entirely — a
  // read-only report, not a mode of the catalogue — so it's a second, independent toggle
  // rather than a fourth option crammed into the same three.
  const [modeFilter, setModeFilter] = useState("all");
  const [view, setView] = useState("catalog"); // "catalog" | "history"
  const [tab, setTab] = useState("consultations");
  // Bumped by Refresh and handed to whichever panel is open, so it refetches in place.
  const [reloadTick, setReloadTick] = useState(0);
  // A callback ref, not useRef: the portal has to re-render once the node exists, and a
  // ref object mutating in place never triggers that.
  const [createSlot, setCreateSlot] = useState(null);

  const visibleTabs = TABS.filter((t) => MODE_TAB_KEYS[modeFilter].has(t.key));

  // Falls back to Consultations rather than leaving `tab` pointed at a key the new mode
  // doesn't carry — Equipment picked under Offline, then Online clicked, would otherwise
  // show a sub-tab bar with nothing selected.
  const selectMode = (key) => {
    setModeFilter(key);
    setView("catalog");
    if (!MODE_TAB_KEYS[key].has(tab)) setTab("consultations");
  };

  // The Dashboard's own date-filter strip, to the class: a squared button, bordered and
  // white while idle, solid blue when it is the one selected. Written once here because
  // History sits in this row as a peer of the three modes, and two copies of the styling
  // is how the row ends up with three buttons of one shape and a fourth of another.
  const scopeBtn = (on) => `h-10 shrink-0 rounded-md px-3 text-sm font-medium transition ${
    on ? "bg-sky-600 text-white" : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
  }`;

  return (
    <div className="space-y-4" data-testid="packages-board">
      {/* No heading. The nav tab above already reads Services and Products, and the line
          under it only listed the tabs that follow it. */}
      <div className="flex flex-wrap items-center gap-2" data-testid="packages-mode-filter">
        {MODE_FILTERS.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => selectMode(m.key)}
            className={scopeBtn(view === "catalog" && modeFilter === m.key)}
            data-testid={`packages-mode-filter-${m.key}`}
          >
            {m.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setView("history")}
          className={scopeBtn(view === "history")}
          data-testid="packages-view-history"
        >
          History
        </button>
      </div>

      {/* A dropdown on a phone, the same control the Branch Admin store uses. Eight tabs
          wrapped to three rows there, which pushed the shelf being edited below the fold
          before any of its items showed. Desktop keeps the bar. Neither one has anything
          to pick under History — it has no sub-tabs of its own — so both drop out there;
          Refresh and the Create slot stay put regardless, since History still refreshes.

          Refresh and Create ride alongside it. Create is not this component's to render —
          each panel owns its own, against its own item type — so the panel portals an
          icon-only copy into the slot at the end of this row. */}
      <div className="flex items-center gap-2 md:hidden">
        {view === "catalog" && (
          <select
            value={tab}
            onChange={(e) => setTab(e.target.value)}
            className="h-11 min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700"
            data-testid="packages-subtab-select"
          >
            {visibleTabs.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        )}
        <Button
          onClick={() => setReloadTick((n) => n + 1)}
          title="Refresh"
          aria-label="Refresh"
          className="h-11 w-11 shrink-0 bg-slate-500 p-0 text-white hover:bg-slate-600"
          data-testid="packages-refresh"
        >
          <RefreshCw className="h-4 w-4" />
        </Button>
        <div ref={setCreateSlot} className="flex shrink-0 items-center" data-testid="packages-create-slot" />
      </div>

      {view === "catalog" && (
        // Justified across the bar: all twelve on one line at a desk width, spread to the
        // full width rather than packed at the left with a gap trailing off the end.
        // 13px type with the padding pulled in to pay for it — the space that buys goes
        // between the tabs, where justify-between puts it, instead of inside each one.
        // Still wrapping rather than scrolling: the fit is a fit and not a guarantee, and a
        // narrower window taking a second row is the honest failure. As a scroller the
        // overflow was a half-cut tab at the right edge with nothing to say it continued.
        <div className="hidden flex-wrap justify-between gap-1 rounded-lg border border-slate-200 bg-white p-1 md:flex" data-testid="packages-subtabs">
          {visibleTabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                data-testid={`packages-subtab-${t.key}`}
                className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-2 text-[13px] font-medium transition ${active ? "bg-violet-50 text-violet-600" : "text-slate-600 hover:bg-slate-50"}`}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />{t.label}
              </button>
            );
          })}
        </div>
      )}

      {view === "catalog" && tab === "consultations" && <ConsultationsPanel reloadToken={reloadTick} toolbarSlot={createSlot} modeFilter={modeFilter} />}
      {view === "catalog" && tab === "sessions" && <SessionsPanel reloadToken={reloadTick} toolbarSlot={createSlot} modeFilter={modeFilter} />}
      {/* The same panel Sessions runs, told which catalogue it is looking at. Its Create
          opens the session package form, which is what was asked for — one form behind
          every one of these shelves, rather than a near-copy each that drifts apart. */}
      {view === "catalog" && SESSION_LIKE_TABS[tab] && (
        <SessionsPhysiotherapyPanel
          key={tab}
          category={SESSION_LIKE_TABS[tab].category}
          noun={SESSION_LIKE_TABS[tab].noun}
          reloadToken={reloadTick}
          toolbarSlot={createSlot}
          modeFilter={modeFilter}
        />
      )}
      {view === "catalog" && tab === "home_visit" && <HomeVisitPanel reloadToken={reloadTick} toolbarSlot={createSlot} modeFilter={modeFilter} />}
      {view === "catalog" && tab === "diet" && <DietDetailsPanel reloadToken={reloadTick} toolbarSlot={createSlot} modeFilter={modeFilter} />}
      {view === "history" && <HistoryPanel reloadToken={reloadTick} />}
      {view === "catalog" && tab === "treatment" && <TreatmentTypesBoard />}
      {view === "catalog" && tab === "physio_type" && <PhysioTypesBoard />}
      {view === "catalog" && INVENTORY_TABS.has(tab) && <SuperAdminInventoryPanel key={tab} category={tab} reloadToken={reloadTick} />}
      {/* No branch picker, unlike the three shelves above it: the vendor list is
          org-wide and holds no counts, so there is nothing for a branch to name. Left
          unscoped, the delivery totals on each row are every branch's — which is the
          figure this desk is looking for. */}
      {view === "catalog" && tab === "vendor" && <VendorPanel reloadToken={reloadTick} />}
      {/* Whatever has no panel yet. A tab graduates by being handled above rather than by
          another branch being added here. */}
      {view === "catalog" && !BUILT_TABS.has(tab) && visibleTabs.map((t) => tab === t.key && (
        <PlaceholderPanel key={t.key} label={t.label} testid={`packages-panel-${t.key}`} />
      ))}
    </div>
  );
};

export default PackagesBoard;
