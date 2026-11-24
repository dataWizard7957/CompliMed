import json
import logging
import re
from typing import Any, Dict, Tuple
from litellm import completion
import litellm
from pydantic import BaseModel, Field
from dotenv import load_dotenv
load_dotenv()

logger = logging.getLogger(__name__)

# Configure LiteLLM for rate-limit retries with exponential backoff
litellm.num_retries = 5


class ViolationItem(BaseModel):
    rule_id: str
    severity: str
    description: str


class AuditSchema(BaseModel):
    overall_compliant: bool
    confidence_score: float
    violations: list[ViolationItem] = Field(default_factory=list)


BASELINE_SYSTEM_PROMPT = """
You are a medical compliance auditor. Analyze the clinical record for compliance violations.

OUTPUT REQUIREMENTS:
Return your response in a JSON-like structure with overall_compliant (boolean), confidence_score (float), and violations list.
"""


def run_baseline_audit(
    record: Dict[str, Any], model: str = "gemini/gemini-3.1-pro-preview"
) -> Tuple[Dict[str, Any], bool]:
    user_prompt = f"""
    Record ID: {record.get('record_id')}
    Patient Hash/ID: {record.get('patient_id_hash')}
    Department: {record.get('department')}
    ICD-10 Codes: {record.get('icd10_codes')}
    CPT Codes: {record.get('cpt_codes')}
    Prior Auth Token: {record.get('prior_auth_token')}
    Clinical Notes: {record.get('clinical_notes')}
    """

    try:
        # Single-shot prompt without structured response_format constraints
        response = completion(
            model=model,
            messages=[
                {"role": "system", "content": BASELINE_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.0,
            num_retries=5,
        )

        raw_text = response.choices[0].message.content.strip()

        # Sanitize markdown ticks if present
        cleaned_text = re.sub(
            r"^```(?:json)?\s*|\s*```$", "", raw_text, flags=re.MULTILINE
        ).strip()

        parsed_json = json.loads(cleaned_text)

        # Validate basic schema structure using Pydantic
        validated_obj = AuditSchema.model_validate(parsed_json)
        validated_dict = validated_obj.model_dump()

        return validated_dict, True

    except Exception as e:
        logger.warning(
            f"[Baseline Audit Error] Record {record.get('record_id')}: {e}"
        )
        return {
            "overall_compliant": True,
            "confidence_score": 0.0,
            "violations": [],
            "error": str(e),
        }, False


if __name__ == "__main__":
    from pathlib import Path
    
    dataset_path = Path("data/eval_dataset.json")
    if dataset_path.exists():
        with open(dataset_path, "r", encoding="utf-8") as f:
            dataset = json.load(f)
        sample_record = dataset[0]["record"]
    else:
        sample_record = {}

    print(f"Running baseline audit on {sample_record.get('record_id', 'Sample Record')}...")
    result, success = run_baseline_audit(sample_record)
    print(f"Success: {success}")
    print("Baseline JSON Output:")
    print(json.dumps(result, indent=2))