/**
 * Print foundation: opens a print window with 80mm-styled RTL content.
 * Real thermal printer integration (ESC/POS) arrives in a later phase —
 * this renders the same receipt/ticket data through the browser dialog.
 */
export function printHtml(title: string, bodyHtml: string, dir: "rtl" | "ltr" = "rtl"): void {
  const win = window.open("", "_blank", "width=420,height=640");
  if (!win) return;
  win.document.write(`<!doctype html>
<html dir="${dir}" lang="${dir === "rtl" ? "ar" : "en"}">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  /* Page-only concerns — the receipt's own visual template (classic/modern/
     minimal) ships its own scoped <style> block inside bodyHtml itself,
     shared with the on-screen dialog preview (see ReceiptView.tsx). */
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 80mm; padding: 4mm; }
  @media print { body { width: auto; } }
</style>
</head>
<body>${bodyHtml}</body>
</html>`);
  win.document.close();
  win.focus();
  setTimeout(() => {
    win.print();
    win.close();
  }, 250);
}
