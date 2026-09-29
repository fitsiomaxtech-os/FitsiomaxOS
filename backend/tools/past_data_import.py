"""Import one of the clinic's pre-OS Excel sheets -- the register, or a branch's monthly
revenue sheet -- into the Past Data tables.

Dry-run by default. Prints what the workbook holds and what would be written, and writes
nothing:

    cd backend && python tools/past_data_import.py /root/Max00data.xlsm
    cd backend && python tools/past_data_import.py /root/Max00data.xlsm --branch PAS
    cd backend && python tools/past_data_import.py /root/Max00data.xlsm --branch PAS --apply
    cd backend && python tools/past_data_import.py /root/Parrys.xlsx --branch PAS --apply --label Parrys
    cd backend && python tools/past_data_import.py /root/Max00data.xlsm --branch PAS --apply --replace PDI-260929-153012-a1b2
    cd backend && python tools/past_data_import.py --branch PAS --remove PDI-260929-153012-a1b2

Without --branch it never opens the database, so the first form runs anywhere the workbook
is -- that is the one to run while the workbook is still being cleaned up. --findings-csv
writes every finding to a CSV that opens in Excel beside the workbook it is about.

Where it writes, and what it leaves alone.

Three collections of its own -- past_clients, past_treatments, past_payments -- plus one
row per import in past_imports. Nothing else: not leads, not lead_activity, not sessions.
That is the whole design (see past_data.py): the live boards, dashboards and finance
figures read those other collections, so none of them can see a row this writes, and an
import cannot change a number anybody is already reporting.

Every row carries the batch id of the import that wrote it, so --remove takes one import
back out exactly. Each import is one sheet, and a branch holds as many as are added: --apply
adds this one beside the others, and --replace BATCH_ID puts it in place of that one --
writing the new batch in full before it removes the old, so a failure half way leaves the
old data standing rather than nothing. The very same file twice is refused.

The workbook holds patients' names and phone numbers. Upload it to the server outside the
repository (e.g. /root/), and delete it once the import is checked -- never commit it.
"""
import asyncio
import csv
import hashlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import past_data  # noqa: E402

EXAMPLES_PER_FINDING = 6


def rupees(value) -> str:
    """Rs. with Indian digit grouping: Rs.1,34,38,570."""
    whole, _, paise = f"{float(value or 0):.2f}".partition(".")
    sign = "-" if whole.startswith("-") else ""
    whole = whole.lstrip("-")
    head, tail = whole[:-3], whole[-3:]
    groups = []
    while len(head) > 2:
        groups.insert(0, head[-2:])
        head = head[:-2]
    if head:
        groups.insert(0, head)
    text = ",".join(groups + [tail]) if groups else tail
    return f"Rs.{sign}{text}" + (f".{paise}" if paise != "00" else "")


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def print_report(data: past_data.PastData, show_all: bool = False) -> None:
    s = past_data.summary(data)
    states = s["payment_states"]

    def state(name):
        bucket = states.get(name, {"rows": 0, "amount": 0})
        return bucket["rows"], bucket["amount"]

    paid_rows, paid_amount = state("paid")
    unpaid_rows, unpaid_amount = state("unpaid")
    cancelled_rows, _ = state("cancelled")
    unknown_rows, _ = state("unknown")

    revenue = s["layout"] == "revenue"
    print()
    if revenue:
        print(f"A revenue sheet: one payment a row, from the tabs {', '.join(s['tabs'])}.")
    print("Would write:")
    print(f"  past_clients     {s['clients']:>5}"
          + ("" if revenue else f"   ({s['enquiries_attached']} of {s['enquiries_read']} enquiries attached to them)"))
    print(f"  past_treatments  {s['treatments']:>5}")
    print(f"  past_payments    {s['payments']:>5}")
    print(f"      paid         {paid_rows:>5}   {rupees(paid_amount)}")
    if not revenue:
        print(f"      unpaid       {unpaid_rows:>5}   {rupees(unpaid_amount)} still owed when the workbook was saved")
        print(f"      cancelled    {cancelled_rows:>5}")
    if unknown_rows:
        print(f"      unknown      {unknown_rows:>5}")

    by_code = {}
    for finding in data.findings:
        by_code.setdefault(finding.code, []).append(finding)
    flagged = [c for c in past_data.FINDINGS if c in by_code and c not in past_data.NOT_IMPORTED]
    left_out = [c for c in past_data.FINDINGS if c in by_code and c in past_data.NOT_IMPORTED]

    def block(title, codes):
        if not codes:
            return
        print()
        print(title)
        for code in codes:
            rows = by_code[code]
            print(f"  {code:<18} {len(rows):>4}  {past_data.FINDINGS[code]}")
            for finding in rows if show_all else rows[:EXAMPLES_PER_FINDING]:
                print(f"      {finding.excel_id:<12} {finding.detail}")
            if not show_all and len(rows) > EXAMPLES_PER_FINDING:
                print(f"      ... and {len(rows) - EXAMPLES_PER_FINDING} more (--all, or --findings-csv)")

    block("Imported with a flag -- fix in the workbook and re-import to clear:", flagged)
    block("Left out:", left_out)


def write_findings_csv(data: past_data.PastData, path: Path) -> None:
    with open(path, "w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.writer(handle)
        writer.writerow(["Finding", "Meaning", "Sheet", "ID", "Detail", "Imported"])
        for f in data.findings:
            writer.writerow([
                f.code, past_data.FINDINGS.get(f.code, ""), f.sheet, f.excel_id, f.detail,
                "no" if f.code in past_data.NOT_IMPORTED else "yes, flagged",
            ])
    print(f"\nFindings written to {path}")


# ----------------------------------------------------------------------------- database
#
# The writing itself lives in past_data_store.py, shared with the Import Excel button on the
# Past Data tab. Imported inside run_with_database rather than used from here, for the same
# reason database.py is: the report above has to run where there is no .env at all.


async def run_with_database(args, data, source: Path | None) -> int:
    from database import v3_col  # noqa: E402 -- see the note above
    from past_data_store import find_branch, live_imports, remove_batch, write_batch  # noqa: E402

    branch = await find_branch(v3_col, args.branch)
    if not branch:
        print(f"\nNo single branch with code {args.branch!r}.")
        return 1
    print(f"\nBranch: {branch.get('branch_name')} ({branch.get('code')})"
          + (" -- archived" if branch.get("archived") else ""))
    existing = await live_imports(v3_col, branch["id"])

    if args.remove:
        match = next((b for b in existing if b["id"] == args.remove), None)
        if not match:
            print(f"No import {args.remove!r} on this branch. Imports here: "
                  + (", ".join(b["id"] for b in existing) or "none"))
            return 1
        removed = await remove_batch(v3_col, args.remove)
        print("Removed " + ", ".join(f"{n} {name}" for name, n in removed.items()) + f" from {args.remove}.")
        return 0

    for b in existing:
        counts = b.get("counts", {})
        print(f"Already holds {b['id']}: {counts.get('past_clients', 0)} clients, "
              f"{counts.get('past_treatments', 0)} treatments, {counts.get('past_payments', 0)} payments "
              f"from {b.get('source_file')} ({str(b.get('imported_at', ''))[:16]})")

    if not args.apply:
        print("\nNothing written. Re-run with --apply to add it as a sheet"
              + (", or --apply --replace BATCH_ID to put it in place of one above." if existing else "."))
        return 0
    replacing = None
    if args.replace:
        replacing = next((b for b in existing if b["id"] == args.replace), None)
        if not replacing:
            print(f"\nNot written: no import {args.replace!r} on this branch to replace.")
            return 1
    sha = sha256_of(source)
    same = next((b for b in existing if b.get("file_sha256") == sha), None)
    if same and same is not replacing:
        print(f"\nNot written: this very file is already imported here as {same['id']}.")
        return 1

    batch_id = await write_batch(v3_col, data, branch, source.name, sha, label=args.label or "")
    print(f"\nImported as {batch_id}.")
    if replacing:
        removed = await remove_batch(v3_col, replacing["id"])
        print(f"Replaced {replacing['id']} (removed {sum(removed.values())} rows).")
    print(f"To take it back out: python tools/past_data_import.py --branch {branch.get('code')} --remove {batch_id}")
    return 0


def parse_args(argv):
    import argparse
    parser = argparse.ArgumentParser(description="Import a pre-OS Excel sheet into Past Data.")
    parser.add_argument("workbook", nargs="?", help="Path to the sheet, e.g. Max00data.xlsm")
    parser.add_argument("--branch", help="Code of the Past Data branch, e.g. PAS")
    parser.add_argument("--apply", action="store_true", help="Write it (default is a dry run)")
    parser.add_argument("--replace", metavar="BATCH_ID", help="With --apply: put this sheet in place of that import")
    parser.add_argument("--label", help="With --apply: what the Past Data tab calls this sheet (default: the file name)")
    parser.add_argument("--remove", metavar="BATCH_ID", help="Take one import back out (needs --branch)")
    parser.add_argument("--all", action="store_true", help="List every finding, not the first few of each")
    parser.add_argument("--findings-csv", metavar="PATH", help="Also write every finding to a CSV")
    args = parser.parse_args(argv)
    if args.remove and not args.branch:
        parser.error("--remove needs --branch")
    if args.apply and not args.branch:
        parser.error("--apply needs --branch")
    if not args.remove and not args.workbook:
        parser.error("give the workbook to read")
    return args


def main(argv=None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    data, source = None, None
    if not args.remove:
        source = Path(args.workbook)
        if not source.is_file():
            print(f"No file at {source}")
            return 1
        try:
            data = past_data.read_workbook(source)
        except past_data.PastDataError as e:
            print(f"Cannot read {source.name}: {e}")
            return 1
        print(f"Workbook: {source.name}")
        print_report(data, show_all=args.all)
        if args.findings_csv:
            write_findings_csv(data, Path(args.findings_csv))
    if not args.branch:
        print("\nNothing written (no --branch given, database not opened).")
        return 0
    return asyncio.run(run_with_database(args, data, source))


if __name__ == "__main__":
    sys.exit(main())
