# Here are your Instructions

## Mobile SMS login

Staff can sign in with their registered mobile number, password, and a six-digit SMS
code. The existing email login remains available. Accounts with email two-factor
authentication enabled must still complete that step after SMS verification.

SMS login is **disabled by default**. It requires a paid SMS provider account; the
implemented adapter uses [Twilio Verify](https://www.twilio.com/docs/verify/api).
No real SMS delivery has been tested without provider credentials.

### Configure the server

1. Create and fund a Twilio account, create a dedicated Verify Service for this OS,
   select a **six-digit** code length, and enable SMS for the destination countries.
   Keep Twilio's fraud protection enabled. Complete any sender/registration requirements
   shown by the provider for those countries. Trial accounts may restrict recipients.
2. Add these values to `backend/.env` on the server. Never put them in frontend variables
   or commit them to Git:

   ```dotenv
   SMS_LOGIN_ENABLED=false
   TWILIO_ACCOUNT_SID=AC_REPLACE_WITH_ACCOUNT_SID
   TWILIO_AUTH_TOKEN=REPLACE_WITH_SECRET
   TWILIO_VERIFY_SERVICE_SID=VA_REPLACE_WITH_VERIFY_SERVICE_SID
   SMS_LOGIN_DAILY_LIMIT=100
   ```

3. In HR user-account settings, make sure each pilot account has its own `mobile_number`.
   Use `+91` and the ten-digit Indian mobile number, or a full international number.
   Indian national numbers and common spaces/dashes are accepted. Employee contact numbers
   are not automatically enrolled as login numbers. Duplicate active login numbers are
   rejected rather than selecting an arbitrary account.
4. Set `SMS_LOGIN_ENABLED=true` and restart the backend. The login screen will offer
   **Mobile + SMS** when the credentials are present and structurally valid. This does
   not check provider balance or prove delivery; run a real pilot sign-in before rollout.
5. Test correct and incorrect codes, resend, expiry, and email 2FA with a pilot account.
   To disable mobile login, set `SMS_LOGIN_ENABLED=false` and restart the backend.
   Existing email sign-in remains available.

### Limits and behavior

- The password is checked before any SMS is sent; no session exists until verification
  and any existing email gate finish.
- A challenge expires five minutes after the first request and allows five code checks.
  Resending does not extend expiry or reset the attempt count. Twilio may resend the
  same code within its own validity window; this application enforces its shorter window.
- Resends and fresh starts share a 60-second account cooldown. SMS attempts are capped
  at five per number per UTC hour and `SMS_LOGIN_DAILY_LIMIT` across the install per UTC
  day. Failed provider requests also use the budget. Start requests are limited to 30
  per client IP per UTC hour. These limits are stored atomically in MongoDB.
- Only trust proxy forwarding from the actual reverse proxy in the ASGI server. The app
  uses the ASGI client address, not a caller-supplied forwarded header. An incorrect proxy
  configuration can cause multiple users to share the same IP limit.
- Codes and credentials are never returned to the browser or stored in challenge records.
  A consumed code cannot create another session. Deactivation, password changes, or
  changes to the registered number invalidate outstanding challenges.
- SMS is vulnerable to SIM swaps; retain email 2FA for sensitive accounts. This feature
  adds an optional sign-in path, not an organization-wide requirement to use SMS.

### Offline tests

Install `backend/requirements.txt` and `backend/requirements-test.txt`, then run:

```sh
python -m pytest backend/tests/test_mobile_login.py backend/tests/test_email_check.py -q
```

These tests use an in-memory Mongo stand-in and mocked SMS delivery. They send no messages
and do not contact the production database. A live provider delivery test remains required.
