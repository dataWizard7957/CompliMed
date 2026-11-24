import json
import logging
import sys
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

sys.path.append(str(Path(__file__).resolve().parent.parent))

from src.agent.system import audit_agent
from src.agent.dependencies import AuditDependencies

log_file = Path("trajectories.log")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(log_file, mode="w", encoding="utf-8"),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger("TrajectoryCapture")

dataset_path = Path("data/eval_dataset.json")
if dataset_path.exists():
    with open(dataset_path, "r") as f:
        dataset = json.load(f)
else:
    raise FileNotFoundError("Could not find data/eval_dataset.json.")

valid_icd10 = {"M17.11", "J45.909", "I10", "E11.9"}
cpt_matrix = {"27447": ["M17.11"], "99213": ["I10", "E11.9"]}

deps = AuditDependencies(
    valid_icd10_codes=valid_icd10,
    cpt_icd_matrix=cpt_matrix
)

# Run trajectories for both a compliant record (Index 0) and a non-compliant record (Index 1)
for idx, sample_entry in enumerate(dataset[:2]):
    sample_record = sample_entry.get("record", sample_entry)
    rec_id = sample_record.get('record_id')
    patient_hash = sample_record.get('patient_id_hash')
    department = sample_record.get('department')
    icd10 = sample_record.get('icd10_codes')
    cpt = sample_record.get('cpt_codes')
    prior_auth = sample_record.get('prior_auth_token')
    notes = sample_record.get('clinical_notes')

    prompt = f"""
Audit this clinical record for compliance violations:
Record ID: {rec_id}
Patient Hash/ID: {patient_hash}
Department: {department}
ICD-10 Codes: {icd10}
CPT Codes: {cpt}
Prior Auth Token: {prior_auth}
Clinical Notes: {notes}
"""

    logger.info(f"\n\n==================================================")
    logger.info(f"=== REPRESENTATIVE TRAJECTORY #{idx + 1} (RECORD: {rec_id}) ===")
    logger.info(f"==================================================")
    logger.info(f"User Prompt Sent to Agent:\n{prompt.strip()}")

    try:
        result = audit_agent.run_sync(prompt, deps=deps)
        
        logger.info(f"=== AGENT EXECUTION COMPLETED FOR {rec_id} ===")
        
        output_data = result.output.model_dump() if hasattr(result.output, 'model_dump') else result.output
        logger.info(f"Final Structured Output (AuditReport):\n{json.dumps(output_data, indent=2)}")
        
        if hasattr(result, 'all_messages'):
            logger.info(f"=== TOOL CALL & FEEDBACK TRACE FOR {rec_id} ===")
            for i, msg in enumerate(result.all_messages()):
                logger.info(f"Message {i} [{msg.kind}]: {msg}")

    except Exception as e:
        logger.error(f"Agent execution failed for {rec_id}: {e}", exc_info=True)

logger.info(f"\nAll representative trajectories successfully saved to {log_file.resolve()}")