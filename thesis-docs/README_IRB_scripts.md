# IRB doc parsing and fill-in scripts

These scripts help you use your thesis-docs with the Purdue IRB templates (HRP-503c, HRP-502b).

## Setup

- **Python 3** (you already have it).
- For **.docx** parsing: `pip install python-docx` (or `python3 -m pip install python-docx`).
- For **.doc** parsing on macOS: no extra install (uses `textutil`). On Linux you can install `antiword` if needed.

## Files

| File | Purpose |
|------|--------|
| `parse_irb_docs.py` | Parse HRP-502b (.doc) and HRP-503c (.docx); print/save structure and full text. |
| `fill_irb_from_thesis.py` | Map thesis-docs content to template placeholders; output a fill-in guide. |
| `requirements-irb.txt` | Python deps for parsing (python-docx). |
| `IRB_parsed_output.txt` | Saved output of `parse_irb_docs.py` (run script once to create). |
| `IRB_fill_in_guide.md` | Generated guide: what to replace in 502b/503c (from `fill_irb_from_thesis.py`). |

## Usage

### 1. Parse the IRB templates (read them into text)

Put the Word files in the **repo root** (one level up from `thesis-docs/`):

- `HRP- 502b- Exempt Research Information Sheet.doc`
- `2026-01-21 HRP-503c Protocol - Exempt Research (1).docx`

Then run:

```bash
cd /path/to/pulse
python3 thesis-docs/parse_irb_docs.py
```

To save the parsed text:

```bash
python3 thesis-docs/parse_irb_docs.py > thesis-docs/IRB_parsed_output.txt
```

To parse specific files:

```bash
python3 thesis-docs/parse_irb_docs.py "path/to/HRP-502b.doc" "path/to/HRP-503c.docx"
```

### 2. Generate the fill-in guide (map thesis content to placeholders)

```bash
python3 thesis-docs/fill_irb_from_thesis.py
```

This creates/overwrites **`thesis-docs/IRB_fill_in_guide.md`** with:

- Exact text to paste into **HRP-502b** for each `[insert ...]` / instruction.
- Section-by-section guidance for **HRP-503c** (which parts of `IRB_Protocol.txt` to use where).

### 3. Fill the Word documents

1. Open **HRP-502b** and **HRP-503c** in Word.
2. Use **`IRB_fill_in_guide.md`** and **`IRB_parsed_output.txt`** (optional) to see all placeholders and structure.
3. In **HRP-502b**: replace each placeholder with the “With” text from the guide.
4. In **HRP-503c**: copy from `thesis-docs/IRB_Protocol.txt` into each section as indicated in the guide.
5. Add your **PI email** and **IRB protocol number** once you have them (the guide marks where).

## Customizing the fill-in content

Edit **`thesis-docs/fill_irb_from_thesis.py`** and change the constants at the top (e.g. `PI_EMAIL`, `DEPARTMENT`, `STUDY_TITLE`, or any of the paragraph-length strings). Then run the script again to regenerate **`IRB_fill_in_guide.md`**.
