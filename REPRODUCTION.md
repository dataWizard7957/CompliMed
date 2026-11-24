# Reproduction Guide

This guide provides instructions to set up the environment, generate datasets, run the evaluation suite, execute the autonomous audit agent, and verify outputs from a clean installation.

---

## Prerequisites & System Requirements

* **Operating System:** Linux, macOS, or Windows (via WSL2 / PowerShell)
* **Python:** Version 3.10 or higher
* **API Key:** A valid Google Gemini API key (`GEMINI_API_KEY`)

## Environment Setup

1. **Navigate to the project directory:**
```bash
git clone 
cd clinical_ops

```

2. **Create and activate a virtual environment:**
```bash
python -m venv venv
# On Linux/macOS:
source venv/bin/activate
# On Windows (PowerShell):
venv\Scripts\Activate.ps1

```

3. **Install dependencies:**
```bash
pip install -r requirements.txt

```


4. **Configure environment variables:**
Create a `.env` file in the root directory and add the Gemini API key:
```env
GEMINI_API_KEY=your_actual_api_key_here

```

---


##  Execution Workflow

Execute the scripts in the precise sequence below to generate data, test the baseline, run the full evaluation suite, and capture agent trajectories.

### Step 1: Generate the Dataset
The evaluation pipeline requires a structured dataset of clinical records. To generate the dataset automatically we need to run

```bash
python scripts/generate_dataset.py

```

This creates or populates `data/eval_dataset.json`, where each record includes:

* `record_id`: Unique identifier (e.g., `REC-1001`)
* `patient_id_hash`: Anonymized patient hash
* `department`: Clinical specialty (e.g., `Orthopedics`)
* `icd10_codes`: List of diagnostic codes
* `cpt_codes`: List of procedure codes
* `prior_auth_token`: Authorization token string
* `clinical_notes`: Text block detailing the patient visit

### Step 2: Run the Baseline

Execute the baseline solver against the generated dataset to establish starting performance benchmark:

```bash
python src/baseline/simple_solver.py

```

### Step 3: Run the Evaluation Suite

Execute the full evaluation script to test the tool-bound agent across the benchmark dataset:

```bash
python tests/eval_suite.py

```

Outputs a comprehensive summary performance metric report saved to `evaluation_results.json`.

### Step 4: Capture Representative Agent Trajectories

Generate the detailed execution trace log (`trajectories.log`) demonstrating multi-turn tool interactions, system prompts, and structured output models:

```bash
python scripts/generate_trajectory.py

```

---

## Operational Metrics

* **Python Version:** 3.10+
* **Key Dependencies:** `pydantic`, `google-genai` / `pydantic-ai`, `httpx`, `python-dotenv`
* **Approximate Runtime:** 15 to 30 seconds for a full batch evaluation dataset (depending on rate limits).
* **Estimated API Cost:** Under $0.05 per full evaluation run using Gemini 3.1 Pro Preview.