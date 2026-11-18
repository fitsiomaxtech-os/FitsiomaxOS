"""Production Environment — what is live, what is waiting, and the button that ships it.

Every push to main used to go straight to the VPS. This puts a person in front of that:
main collects commits, this page lists the ones not yet out, and a deploy happens when
someone with the Production Environment designation presses the button.

Two things about how it runs are worth knowing before reading the code.

The deploy script restarts the API, which is the process that started it. A child would be
killed halfway and the record left saying "running" forever, so the script is launched
detached in its own session and this returns as soon as it is away. The outcome is worked
out afterwards by looking at what HEAD moved to — see `_reconcile`.

What is live is read from the checkout's own git HEAD rather than remembered in the
database. A record can be wrong; the working tree the server is serving cannot.
"""
import asyncio
import os
import shlex
import shutil
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from database import v3_col
from deps import v3_require_roles
from schemas.v3 import V3UserOut
from utils import now_iso

router = APIRouter(prefix="/api/v3/deployments", tags=["deployments"])

# The designation this page exists for, plus Super Admin, who can already do anything.
DEPLOY_ROLES = ("super_admin", "production_environment")

# The repository checkout this API is being served from — two levels up from this file
# (routers/ -> backend/ -> repo root).
REPO_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# The command the button runs. Configurable so the path is not hardcoded into the app and
# so a machine that should never deploy can be given an empty one. Split with shlex and
# executed as an argument list — never through a shell, and never with anything a user
# typed anywhere near it.
DEPLOY_COMMAND = os.environ.get("DEPLOY_COMMAND", "bash /root/deploy-osfitsiomax.sh")

GITHUB_REPO = os.environ.get("GITHUB_REPO", "fitsiomaxtech-os/OSFITSIOMAX")
GITHUB_BRANCH = os.environ.get("GITHUB_BRANCH", "main")

# A deploy that has not moved HEAD after this long is not coming back — the script failed,
# or the box went down mid-way. Long enough to cover a slow frontend build.
STALE_AFTER = timedelta(minutes=30)


def _err(status: int, msg: str):
    return HTTPException(status_code=status, detail=msg)


def _command_problem() -> Optional[str]:
    """Why the configured command could not run, or None if it looks runnable.

    Checked before launching rather than after. The script is detached and its outcome is
    inferred from HEAD moving, so a command that cannot start at all would otherwise sit
    as "running" for half an hour before being called failed — with the real reason, a
    wrong path or a file this process cannot read, never written down anywhere.
    """
    argv = shlex.split(DEPLOY_COMMAND)
    if not argv:
        return "No deploy command is configured on this server"
    if shutil.which(argv[0]) is None:
        return f"'{argv[0]}' is not on this server's PATH"
    for arg in argv[1:]:
        if arg.startswith("/") and not os.path.exists(arg):
            return f"The deploy script {arg} does not exist on this server"
        if arg.startswith("/") and not os.access(arg, os.R_OK):
            return f"The API cannot read {arg} — it runs as a user without access to it"
    return None


async def _git(*args) -> str:
    """Read-only git in the checkout. Returns "" rather than raising: this backs a status
    page, and a page that 500s because git is unavailable tells the reader less than a
    page that says it does not know."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", "-C", REPO_DIR, *args,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=15)
        return out.decode(errors="replace").strip() if proc.returncode == 0 else ""
    except Exception:
        return ""


async def _live_commit() -> dict:
    """What the server is actually running, straight off the checkout."""
    line = await _git("log", "-1", "--format=%H%x1f%s%x1f%an%x1f%aI")
    if not line:
        return {"sha": "", "subject": "", "author": "", "date": ""}
    parts = line.split("\x1f")
    while len(parts) < 4:
        parts.append("")
    return {"sha": parts[0], "subject": parts[1], "author": parts[2], "date": parts[3]}


async def _remote_commits(limit: int = 30) -> tuple:
    """Recent commits on the branch, from GitHub. The repo is public, so this needs no
    token; on any failure the page still renders with what git knows locally and says why
    the waiting list is missing rather than showing an empty one as though nothing waits."""
    url = f"https://api.github.com/repos/{GITHUB_REPO}/commits"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, params={"sha": GITHUB_BRANCH, "per_page": limit})
        if resp.status_code != 200:
            return [], f"GitHub returned {resp.status_code}"
        rows = []
        for c in resp.json():
            commit = c.get("commit") or {}
            author = commit.get("author") or {}
            rows.append({
                "sha": c.get("sha", ""),
                "subject": (commit.get("message") or "").split("\n")[0],
                "author": author.get("name", ""),
                "date": author.get("date", ""),
            })
        return rows, None
    except Exception as exc:
        return [], f"Could not reach GitHub ({type(exc).__name__})"


async def _reconcile(live_sha: str):
    """Close out deploys that are still marked running.

    The script restarts this process, so nothing here writes the finishing line at the
    time it happens. A run is judged afterwards: HEAD moved off what it was, so it worked;
    HEAD never moved and enough time has passed, so it did not. Anything younger than that
    is left alone — it is probably still building.
    """
    running = await v3_col("deployments").find({"status": "running"}, {"_id": 0}).to_list(50)
    for row in running:
        started = row.get("started_at") or ""
        moved = bool(live_sha) and live_sha != row.get("sha_before")
        try:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(started.replace("Z", "+00:00"))
        except Exception:
            age = STALE_AFTER

        if moved:
            await v3_col("deployments").update_one(
                {"id": row["id"]},
                {"$set": {"status": "success", "finished_at": now_iso(), "sha_after": live_sha}},
            )
        elif age >= STALE_AFTER:
            await v3_col("deployments").update_one(
                {"id": row["id"]},
                {"$set": {
                    "status": "failed", "finished_at": now_iso(),
                    "error": "The deploy did not finish and nothing was released. Check the VPS.",
                }},
            )


@router.get("")
async def list_deployments(_: V3UserOut = Depends(v3_require_roles(*DEPLOY_ROLES))):
    """What is live, what is waiting on the button, and everything shipped so far."""
    live = await _live_commit()
    await _reconcile(live["sha"])

    remote, remote_error = await _remote_commits()

    # Everything on the branch above the commit being served. Position in the list, not a
    # date comparison: two commits can share a timestamp, and a rebase rewrites dates.
    pending = []
    if remote:
        if live["sha"]:
            for i, c in enumerate(remote):
                if c["sha"] == live["sha"]:
                    pending = remote[:i]
                    break
            else:
                # Live is not in the recent history at all — a force-push, or a checkout
                # further behind than we listed. Said plainly instead of guessing a number.
                pending = []
                remote_error = remote_error or "The running commit is not in the latest history — the list of waiting commits may be incomplete"
        else:
            pending = remote

    history = await v3_col("deployments").find({}, {"_id": 0}).sort("started_at", -1).to_list(50)
    running = next((h for h in history if h.get("status") == "running"), None)

    return {
        "live": live,
        "pending": pending,
        "pending_count": len(pending),
        "history": history,
        "running": running,
        "branch": GITHUB_BRANCH,
        "repo": GITHUB_REPO,
        # The page says up front whether the button can work at all, and why not, rather
        # than offering a control that fails the moment it is pressed.
        "can_deploy": _command_problem() is None,
        "deploy_blocked_reason": _command_problem(),
        "notice": remote_error,
    }


class DeployIn(BaseModel):
    # Free text kept by the deployer for the record — why this went out, or what to watch.
    note: Optional[str] = ""


@router.post("/deploy")
async def deploy(payload: DeployIn, user: V3UserOut = Depends(v3_require_roles(*DEPLOY_ROLES))):
    """Ship what is on the branch.

    Returns as soon as the script is away rather than waiting for it: the script restarts
    this API, so there is no "after" for this request to run in.
    """
    problem = _command_problem()
    if problem:
        raise _err(400, problem)

    live = await _live_commit()
    await _reconcile(live["sha"])

    # One at a time. Two deploys sharing a checkout is a git working tree being rewritten
    # underneath a build, and the failure would be nothing like as clear as this message.
    already = await v3_col("deployments").find_one({"status": "running"}, {"_id": 0, "id": 1})
    if already:
        raise _err(409, "A deploy is already running")

    record = {
        "id": str(uuid.uuid4()),
        "status": "running",
        "started_at": now_iso(),
        "finished_at": None,
        "sha_before": live["sha"],
        "sha_after": None,
        "triggered_by": user.id,
        "triggered_by_name": user.full_name,
        "note": (payload.note or "").strip(),
        "command": DEPLOY_COMMAND,
    }
    await v3_col("deployments").insert_one(record.copy())

    try:
        # start_new_session detaches it from this process group, so the restart the script
        # performs kills the API without taking the script down with it.
        await asyncio.create_subprocess_exec(
            *shlex.split(DEPLOY_COMMAND),
            cwd=REPO_DIR,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as exc:
        await v3_col("deployments").update_one(
            {"id": record["id"]},
            {"$set": {
                "status": "failed", "finished_at": now_iso(),
                "error": f"Could not start the deploy: {exc}",
            }},
        )
        raise _err(500, f"Could not start the deploy: {exc}")

    return {
        "id": record["id"],
        "status": "running",
        "message": "Deploy started — this page will show the result once the server is back.",
    }
