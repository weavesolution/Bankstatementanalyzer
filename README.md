# Bank Statement Summary

A static web page (GitHub Pages ready) that reads bank statement PDFs **inside the browser**, shows an account-wise and consolidated summary, and exports everything to Excel. No server, no upload — the PDFs never leave the user's computer.

## Features

- Drop multiple statement PDFs at once (password-protected PDFs prompt for the password)
- Auto-detects bank, account number, period, opening / closing balance
- Reconciliation check per account: `Opening + Credits − Debits = Closing`
- Tags each transaction with **Channel** (NEFT / RTGS / IMPS / Cheque …), **Category** (Receipts, Payments, Own-account transfers, Interest, Bank charges, Loan/EMI, Returns) and **Counterparty**
- Own-account transfers detected via other uploaded account numbers, `SELF`, and editable company keywords — so consolidated *external* receipts/payments exclude inter-account movement
- Excel export with sheets: **Summary**, **Category Summary** (with per-account split), **Counterparty Summary**, **Date-wise**, **All Transactions**, and one sheet per account

## Tested statement formats

| Bank | Format |
|---|---|
| Axis Bank | Neo for Corporates "Smart Statement Report" |
| IDBI Bank | Net-banking account statement |
| Indian Overseas Bank | Account statement (CC / CD) |
| Punjab National Bank | Account statement |

The parser is layout-driven (it finds the table header — Date / Description / Debit-Credit or Amount / Balance — and reads columns from it), so most other text-based Indian bank statements also work. Scanned (image-only) PDFs are not supported.

## Deploy on GitHub Pages

1. Create a new repository on GitHub (e.g. `bank-statement-summary`).
2. Upload all files in this folder keeping the structure:
   ```
   index.html
   css/style.css
   js/parser.js
   js/app.js
   README.md
   ```
3. Repository **Settings → Pages → Build and deployment → Source: Deploy from a branch**, select `main` and `/ (root)`, Save.
4. After a minute the site is live at `https://<your-username>.github.io/bank-statement-summary/`.

You can also just open `index.html` locally in Chrome/Edge.

## Libraries (loaded from cdnjs)

- [pdf.js 3.11.174](https://mozilla.github.io/pdf.js/) — PDF text extraction
- [SheetJS 0.18.5](https://sheetjs.com/) — Excel file generation

Only the library code is downloaded; statement data stays in the browser. For a fully offline copy, download the two files and change the `<script src>` paths in `index.html`.

## Adding a new bank format

Open the browser console on a failing file — most issues are header keywords. Column header recognition lives in `classify()` in `js/parser.js`; add the bank's header wording there (e.g. `withdrawal`, `deposit`, `narration`). IFSC prefixes for bank-name detection are in `IFSC_BANKS`.
