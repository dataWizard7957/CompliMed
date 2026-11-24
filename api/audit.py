"""
Vercel serverless function: POST /api/audit

Body:    {"record": {...clinical record...}}
Returns: {"engine": "agent" | "rules", "report": AuditReport}

Uses the Pydantic AI Gemini agent when GEMINI_API_KEY / GOOGLE_API_KEY is set,
otherwise a deterministic rule engine built on the same registries as the
agent's tools. DEMO ONLY: never send real patient data to this endpoint.
"""
import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from src.agent.dependencies import AuditDependencies  # noqa: E402

MAX_BODY_BYTES = 64 * 1024

# Procedures that need a prior authorization token before billing (demo list).
RESTRICTED_CPT = {"27447", "72148"}

# Values that mean "no token was provided".
EMPTY_TOKENS = {"", "NONE", "N/A", "NA", "NULL", "MISSING"}

# A hashed patient identifier is hex-only, 12+ characters.
HASH_RE = re.compile(r"^[0-9a-fA-F]{12,}$")
DOB_RE = re.compile(r"\b(DOB|date of birth)\b|\b\d{4}-\d{2}-\d{2}\b", re.I)
SSN_RE = re.compile(r"\b\d{3}-\d{2}-\d{4}\b")


def _codes(value):
    if isinstance(value, str):
        value = re.split(r"[;,|\s]+", value)
    return [str(c).strip().upper() for c in (value or []) if str(c).strip()]


def normalize(record):
    return {
        "record_id": str(record.get("record_id") or "UNKNOWN"),
        "patient_id_hash": str(record.get("patient_id_hash") or ""),
        "encounter_date": str(record.get("encounter_date") or ""),
        "department": str(record.get("department") or ""),
        "provider_id": str(record.get("provider_id") or ""),
        "icd10_codes": _codes(record.get("icd10_codes")),
        "cpt_codes": _codes(record.get("cpt_codes")),
        "prior_auth_token": str(record.get("prior_auth_token") or "").strip(),
        "clinical_notes": str(record.get("clinical_notes") or ""),
    }


def rule_audit(rec):
    deps = AuditDependencies()
    violations = []
    ambiguous = False

    # 1. HIPAA: patient identifier must be a hash, notes must not leak identifiers.
    pid = rec["patient_id_hash"]
    if pid and not HASH_RE.match(pid):
        violations.append({
            "rule_id": "RULE-HIPAA-01",
            "severity": "CRITICAL",
            "description": "Patient identifier is not anonymized; it appears to contain direct identifiers.",
            "evidence_quote": f"Patient ID: {pid}",
            "remediation_step": "Replace the identifier with the hashed patient ID before the record leaves the EHR.",
        })
    notes = rec["clinical_notes"]
    if SSN_RE.search(notes) or re.search(r"\bDOB\b", notes, re.I):
        violations.append({
            "rule_id": "RULE-HIPAA-02",
            "severity": "HIGH",
            "description": "Clinical notes contain a direct identifier (SSN or date of birth).",
            "evidence_quote": (SSN_RE.search(notes) or DOB_RE.search(notes)).group(0),
            "remediation_step": "Redact the identifier from the notes and re-submit.",
        })

    # 2. ICD-10 validity.
    if not rec["icd10_codes"]:
        violations.append({
            "rule_id": "RULE-ICD-MISSING",
            "severity": "HIGH",
            "description": "No ICD-10 diagnosis code is attached to the encounter.",
            "evidence_quote": "ICD-10 Codes: []",
            "remediation_step": "Ask the provider for the supporting diagnosis and code it.",
        })
    for code in rec["icd10_codes"]:
        if code not in deps.valid_icd10_codes:
            ambiguous = True
            violations.append({
                "rule_id": "RULE-ICD-INVALID",
                "severity": "HIGH",
                "description": f"ICD-10 code {code} is not in the reference registry.",
                "evidence_quote": f"ICD-10 Codes: {rec['icd10_codes']}",
                "remediation_step": f"Verify {code} against the current ICD-10-CM code set and correct it.",
            })

    # 3. CPT ↔ ICD-10 support.
    for cpt in rec["cpt_codes"]:
        allowed = deps.cpt_icd_matrix.get(cpt)
        if allowed is not None and not any(c in allowed for c in rec["icd10_codes"]):
            violations.append({
                "rule_id": "RULE-CPT-ICD-MISMATCH",
                "severity": "HIGH",
                "description": f"Procedure CPT {cpt} is not supported by the listed diagnoses.",
                "evidence_quote": f"ICD-10 Codes: {rec['icd10_codes']}, CPT Codes: {rec['cpt_codes']}",
                "remediation_step": f"CPT {cpt} needs one of {sorted(allowed)}. Confirm the diagnosis with the provider.",
            })

    # 4. Prior authorization.
    restricted = [c for c in rec["cpt_codes"] if c in RESTRICTED_CPT]
    if restricted and rec["prior_auth_token"].upper() in EMPTY_TOKENS:
        violations.append({
            "rule_id": "RULE-PRIOR-AUTH-MISSING",
            "severity": "HIGH",
            "description": f"CPT {', '.join(restricted)} requires prior authorization, but no token is on file.",
            "evidence_quote": f"Prior Auth Token: {rec['prior_auth_token'] or 'NONE'}",
            "remediation_step": "Obtain the payer's prior authorization number and attach it before submitting.",
        })

    if len(notes.strip()) < 20:
        ambiguous = True

    blocking = any(v["severity"] in ("CRITICAL", "HIGH") for v in violations)
    confidence = 0.7 if ambiguous else 0.95
    return {
        "record_id": rec["record_id"],
        "overall_compliant": not blocking,
        "confidence_score": confidence,
        "human_in_the_loop_required": confidence < 0.85,
        "violations": violations,
    }


def agent_audit(rec):
    from src.agent.system import audit_agent  # imported lazily: heavy

    prompt = (
        "Audit this clinical record for compliance violations:\n"
        f"Record ID: {rec['record_id']}\n"
        f"Patient Hash/ID: {rec['patient_id_hash']}\n"
        f"Department: {rec['department']}\n"
        f"ICD-10 Codes: {rec['icd10_codes']}\n"
        f"CPT Codes: {rec['cpt_codes']}\n"
        f"Prior Auth Token: {rec['prior_auth_token'] or 'NONE'}\n"
        f"Clinical Notes: {rec['clinical_notes']}\n"
    )
    result = audit_agent.run_sync(prompt, deps=AuditDependencies())
    return result.output.model_dump()


def audit(record):
    rec = normalize(record)
    if os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY"):
        try:
            return "agent", agent_audit(rec)
        except Exception as exc:  # fall back so the queue keeps moving
            report = rule_audit(rec)
            report["human_in_the_loop_required"] = True
            report["engine_note"] = f"Agent failed ({type(exc).__name__}); rule engine used."
            return "rules", report
    return "rules", rule_audit(rec)


class handler(BaseHTTPRequestHandler):
    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        live = bool(os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY"))
        self._send(200, {"ok": True, "engine": "agent" if live else "rules"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            return self._send(413 if length else 400, {"error": "Body must be 1 byte to 64 KB of JSON."})
        try:
            data = json.loads(self.rfile.read(length))
            record = data.get("record") if isinstance(data, dict) else None
            if not isinstance(record, dict):
                raise ValueError("Missing 'record' object.")
        except (ValueError, json.JSONDecodeError) as exc:
            return self._send(400, {"error": str(exc)})
        engine, report = audit(record)
        self._send(200, {"engine": engine, "report": report})
