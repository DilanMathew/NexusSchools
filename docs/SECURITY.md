# Security & privacy

This platform processes children's personal data. The controls below are implemented. The legal items at the end need review by qualified counsel before production use.

## Implemented controls

**Tenant isolation**
- The tenant comes from the caller's database membership (`X-Institution-Id` only selects among the caller's own memberships).
- Every query is filtered by `institution_id`.
- Referenced ids are checked with `assertOwned`.
- Platform admins have no implicit tenant access.
- Tested in `tests/auth-tenancy.test.ts` and other suites (cross-tenant read, update, delete, references, forged ids, the assistant, devices).

**Authorisation**
- 46 permissions, enforced server-side on every route.
- The UI hides what you can't use, but never relies on hiding.
- No privilege escalation: a caller can grant only permissions they hold, only an owner can grant the owner role, and nobody can change their own roles.
- Scope rules: institution-wide, department, or assigned classes only. Students see only themselves; guardians see only linked children.

**Authentication**
- bcrypt password hashes (cost 11).
- Passwords need 10+ characters with letters and numbers.
- Lockout after 5 failures for 15 minutes; generic error messages.
- JWT access tokens (15 min) are held only in memory.
- Rotating refresh tokens are kept as SHA-256 hashes in an httpOnly, SameSite=Strict, Secure cookie scoped to `/api/auth`. Reusing a refresh token revokes its whole family.
- Password change, reset and account disable revoke all sessions.
- Reset tokens are single-use and expire after 30 min; the response is the same whether or not the account exists.

**Input and output handling**
- Zod validation on every request body and query.
- Parameterised SQL via Drizzle (no string-built queries).
- Helmet with a strict CSP.
- CSV exports neutralise formula injection.
- Uploads are memory-only, limited to CSV, 2 MB and 5,000 rows.

**Rate limiting**: global, auth, QR scan, assistant and device ingest.

**Sensitive fields**
- Medical notes are returned only with `students.medical.read`.
- Contact details are returned only with `students.contact.read`.
- The audit log redacts password hashes, tokens and medical notes.

**Audit**
- Every create, update or delete of sensitive records and every attendance correction is written to `audit_logs` with before and after values.
- Policy changes are versioned.

**QR and devices**
- Attendance QR tokens are HMAC-signed, rotate, and are accepted only for the current and previous window.
- Each scan is bound to the authenticated student, once per session.
- Identity QR codes on ID cards hold an opaque token and can be reissued.
- Device keys are shown once and stored hashed.

**Location and biometrics**
- There is no continuous or background location tracking.
- No facial recognition or other biometrics; the system works without any biometric data.

**AI**
- Read-only, scoped tools; no SQL access and no write access.
- No inference of sensitive characteristics and no automated penalties.
- Usage is logged and capped per plan.

**Secrets**
- Production refuses to start with placeholder secrets.
- Logs redact authorisation headers and cookies.
- No secrets appear in frontend code.

## Needs action before real production use

- **DPDP Act 2023 / Rules.** You need verifiable parental consent workflows for children's data, a consent record store, data-principal rights (access, correction, erasure) workflows, retention schedules, a breach-notification process and a grievance officer contact. The data model leaves room for these, but they are not implemented. **This needs legal review.**
- A privacy policy and terms of use. These do not exist yet.
- Support access workflow for platform staff: the `support_access_grants` table exists, but there is no workflow yet.
- Email and SMS delivery for password resets and notifications, which needs a provider.
- Encrypted backups with a tested restore (see `DEPLOYMENT.md`), plus an external security review or penetration test.
