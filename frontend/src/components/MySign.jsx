import { useEffect, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SignDelete, SignPaper, useSignUpload } from "@/components/ui/sign-editor";
import { toast } from "@/components/ui/sonner";
import { deleteMySignature, mySignature, uploadMySignature } from "@/lib/api";
import { signSrc } from "@/lib/signImage";

const showDay = (iso) => {
  const d = new Date(iso || "");
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

/**
 * My Profile > Sign Upload: everybody's own sign, whatever their desk. It prints where they
 * are the one who signs -- the bills they collect, the prescriptions in their name and the
 * Consultation Forms that name them (backend/staff_sign.py).
 */
export const MySign = () => {
  const [mine, setMine] = useState(null); // { name, image, uploaded_at, uploaded_by }
  const [failed, setFailed] = useState("");
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let live = true;
    setFailed("");
    mySignature()
      .then((r) => { if (live) setMine(r); })
      .catch((e) => { if (live) setFailed(e?.response?.data?.detail || "Couldn't load your sign"); });
    return () => { live = false; };
  }, [tries]);

  const sign = useSignUpload(async (blob) => {
    setMine(await uploadMySignature(blob));
    toast.success("Your sign is saved");
  }, "My Sign");

  if (failed) {
    return (
      <div className="flex flex-col items-start gap-2 text-sm text-slate-500" data-testid="my-sign-failed">
        {failed}
        <Button type="button" variant="outline" size="sm" onClick={() => setTries((n) => n + 1)} className="rounded-[4px]">Retry</Button>
      </div>
    );
  }
  if (!mine) return <div className="flex justify-center py-10 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>;

  const image = signSrc(mine.image);
  return (
    <div className="max-w-md space-y-3" data-testid="my-sign">
      <SignPaper image={image} testid="my-sign-paper">No sign yet</SignPaper>
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-xs text-slate-500">
          {image && mine.uploaded_by ? `Uploaded by ${mine.uploaded_by}${showDay(mine.uploaded_at) ? ` · ${showDay(mine.uploaded_at)}` : ""}` : "Upload a photo of your sign. It is cropped and cleaned by itself."}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {image && <SignDelete onDelete={async () => setMine(await deleteMySignature())} testid="my-sign-delete" />}
          <Button type="button" size="sm" onClick={sign.pick} className="h-8 gap-1.5 rounded-[4px] bg-sky-600 px-3 text-xs hover:bg-sky-700" data-testid="my-sign-upload">
            <Upload className="h-3.5 w-3.5" />Upload
          </Button>
        </div>
      </div>
      {sign.elements}
    </div>
  );
};

export default MySign;
