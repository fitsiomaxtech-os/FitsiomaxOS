"""Whether an email ID may be put on a login: the automatic check, and the one rule that
enforces it.

What the check can and cannot say. It reads the address (the right shape, not a slip like
gmial.com) and asks DNS whether its domain takes mail at all, and whose mail it is. It
cannot say the inbox exists: a made-up name on gmail.com passes. Only a code read out of
the inbox proves that, which is two_factor.py's job and what `email_verified_at` on the
login records. So there are two different words on screen, and they are not the same:

    Valid       this address could receive mail (here)
    Verified    somebody read a code out of it (two_factor.py)

Its own module because the HR router (creating and editing logins) and the Security router
(a person changing their own) both ask it, and the answer has to be the same one.

Only a new or changed address is ever checked. A login already in the OS keeps the one it
has, whatever this would say about it, so nobody is locked out by it.
"""
import logging
import re
import time
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException

from database import v3_col

logger = logging.getLogger(__name__)

VALID = "valid"
INVALID = "invalid"
# The lookup itself failed -- no answer from DNS. Not the address's fault, so it is never
# reported as a bad address; a save is refused with "try again" instead.
UNCHECKED = "unchecked"

# name@domain.tld. Deliberately narrower than the RFC: quoted names and bare hosts are
# legal and nobody's sign-in.
_SHAPE = re.compile(
    r"^[A-Za-z0-9_](?:[A-Za-z0-9._%+'\-]{0,62}[A-Za-z0-9_+\-])?"
    r"@(?:[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9\-]{0,61}[A-Za-z0-9]$"
)
MAX_LENGTH = 254

# The free-mail domains, answered without a lookup: they always take mail, and they are
# what almost everybody types, so a slow DNS server never stands in their way.
_KNOWN = {
    "gmail.com": "google", "googlemail.com": "google",
    "outlook.com": "outlook", "outlook.in": "outlook", "hotmail.com": "outlook",
    "live.com": "outlook", "live.in": "outlook", "msn.com": "outlook",
    "yahoo.com": "yahoo", "yahoo.in": "yahoo", "yahoo.co.in": "yahoo", "ymail.com": "yahoo",
    "zohomail.com": "zoho", "zohomail.in": "zoho",
}

# Slips of the domains above. Several are registered and do take mail, which is exactly why
# they are named: the lookup would pass them, and the code would go to a stranger.
_SLIPS = {
    **dict.fromkeys(
        ("gmial.com", "gmal.com", "gamil.com", "gmai.com", "gmil.com", "gnail.com",
         "gmaill.com", "gmail.co", "gmail.con", "gmail.cm", "gmail.om", "gmail.comm",
         "gmail.in", "gmail.co.in"), "gmail.com"),
    **dict.fromkeys(("hotmial.com", "hotmal.com", "hotmai.com", "hotmail.con"), "hotmail.com"),
    **dict.fromkeys(("outlok.com", "outloook.com", "outlook.con"), "outlook.com"),
    **dict.fromkeys(("yaho.com", "yahooo.com", "yhoo.com", "yahoo.con"), "yahoo.com"),
}

# Whose mail servers a domain points at, by the end of the MX host. This is what says a
# company address is on Google or Microsoft.
_MX_PROVIDERS: Tuple[Tuple[str, str], ...] = (
    ("google.com", "google"), ("googlemail.com", "google"),
    ("outlook.com", "outlook"), ("mx.microsoft", "outlook"), ("hotmail.com", "outlook"),
    ("yahoodns.net", "yahoo"),
    ("zoho.com", "zoho"), ("zoho.in", "zoho"), ("zoho.eu", "zoho"),
)

_DNS_SECONDS = 4
_CACHE_SECONDS = 600
# A "takes no mail" is kept briefly: it is the answer somebody is in the middle of fixing.
_CACHE_SECONDS_NONE = 60
_mx_cache: Dict[str, Tuple[float, List[str]]] = {}


class LookupFailed(RuntimeError):
    """DNS gave no answer either way."""


def normalize(email: Any) -> str:
    """How an email is stored on a login: trimmed and lower case. Sign-in ignores case, and
    Forgot Password looks the lower-case one up, so both spellings have to be one login."""
    return str(email or "").strip().lower()


async def _mx_hosts(domain: str) -> List[str]:
    """The domain's mail servers, or [] when it has none. Raises LookupFailed when DNS
    could not say."""
    hit = _mx_cache.get(domain)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    # Imported here, not at the top: a server without dnspython should refuse this one
    # check, not fail to start.
    try:
        import dns.asyncresolver
        import dns.exception
        import dns.resolver
    except ImportError as exc:
        logger.error("Email check cannot look up domains: dnspython is not installed")
        raise LookupFailed("dnspython missing") from exc
    try:
        resolver = dns.asyncresolver.Resolver()
        answer = await resolver.resolve(domain, "MX", lifetime=_DNS_SECONDS)
        hosts = [str(r.exchange).rstrip(".").lower() for r in answer]
        # A lone "." is a domain saying it takes no mail (RFC 7505).
        hosts = [h for h in hosts if h]
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer):
        hosts = []
    except (dns.exception.DNSException, OSError) as exc:
        logger.warning("Email check: no DNS answer for %s (%s)", domain, type(exc).__name__)
        raise LookupFailed(str(exc)) from exc
    if len(_mx_cache) > 500:
        _mx_cache.clear()
    _mx_cache[domain] = (time.monotonic() + (_CACHE_SECONDS if hosts else _CACHE_SECONDS_NONE), hosts)
    return hosts


def _provider_of(hosts: List[str]) -> str:
    for host in hosts:
        for tail, provider in _MX_PROVIDERS:
            if host == tail or host.endswith("." + tail):
                return provider
    return "other"


def _answer(status: str, email: str, provider: Optional[str] = None, reason: str = "") -> Dict[str, Any]:
    return {"status": status, "email": email, "provider": provider, "reason": reason}


async def check(email: Any) -> Dict[str, Any]:
    """{ status, email, provider, reason } for one address. Says nothing about whether the
    OS already uses it -- see check_for_login."""
    value = normalize(email)
    if len(value) > MAX_LENGTH or ".." in value or not _SHAPE.match(value):
        return _answer(INVALID, value, reason="Enter a full Email ID, like name@gmail.com")
    name, domain = value.rsplit("@", 1)
    if domain in _SLIPS:
        return _answer(INVALID, value, reason=f"Did you mean {name}@{_SLIPS[domain]}?")
    # Gmail never gives out anything but letters, numbers and dots (a "+tag" may follow).
    if domain in ("gmail.com", "googlemail.com") and not re.fullmatch(r"[a-z0-9.]+(\+.*)?", name):
        return _answer(INVALID, value, reason="Gmail allows only letters, numbers and dots")
    if domain in _KNOWN:
        return _answer(VALID, value, provider=_KNOWN[domain])
    try:
        hosts = await _mx_hosts(domain)
    except LookupFailed:
        return _answer(UNCHECKED, value, reason="Could not check this Email ID now. Try again.")
    if not hosts:
        return _answer(INVALID, value, reason=f"{domain} cannot receive email")
    return _answer(VALID, value, provider=_provider_of(hosts))


async def provider_of(email: Any) -> Optional[str]:
    """Whose mail an address is on (google / outlook / yahoo / zoho / other), or None when it
    is not a valid address or DNS could not say. For the "Verified by" mark beside a login's
    email, which names the mailbox the code was read out of."""
    result = await check(email)
    return result["provider"] if result["status"] == VALID else None


async def _taken(email: str, exclude_user_id: Optional[str]) -> bool:
    # Case-blind: some older logins are stored in mixed case.
    query: Dict[str, Any] = {"email": {"$regex": f"^{re.escape(email)}$", "$options": "i"}}
    if exclude_user_id:
        query["id"] = {"$ne": exclude_user_id}
    return bool(await v3_col("users").find_one(query, {"_id": 0, "id": 1}))


async def check_for_login(email: Any, exclude_user_id: Optional[str] = None) -> Dict[str, Any]:
    """check(), and whether another login already has it."""
    result = await check(email)
    if result["status"] == VALID and await _taken(result["email"], exclude_user_id):
        return _answer(INVALID, result["email"], provider=result["provider"], reason="Already used by another login")
    return result


async def require_allowed(email: Any, exclude_user_id: Optional[str] = None) -> str:
    """The address as it should be stored, or a refusal. Every write of a new or changed
    login email goes through here, so the screens' own check cannot be walked round."""
    result = await check_for_login(email, exclude_user_id)
    if result["status"] == VALID:
        return result["email"]
    if result["status"] == UNCHECKED:
        raise HTTPException(status_code=503, detail=result["reason"])
    taken = result["reason"].startswith("Already used")
    raise HTTPException(
        status_code=409 if taken else 400,
        detail=f"Email ID not allowed: {result['reason']}",
    )
