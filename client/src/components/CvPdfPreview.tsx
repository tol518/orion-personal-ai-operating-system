import { useEffect, useRef, useState } from "react";
import {
  getDocument,
  GlobalWorkerOptions,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export default function CvPdfPreview({ url }: { url: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let loadedDocument: PDFDocumentProxy | null = null;
    setDocument(null);
    setError(null);
    const loadingTask = getDocument({ url });
    loadingTask.promise
      .then((pdf) => {
        loadedDocument = pdf;
        if (active) setDocument(pdf);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Unable to render this PDF");
      });
    return () => {
      active = false;
      void loadingTask.destroy();
      if (loadedDocument) void loadedDocument.destroy();
    };
  }, [url]);

  if (error) {
    return <div className="hunting-cv-preview__state hunting-cv-preview__state--error"><b>PDF could not be displayed</b><span>{error}</span></div>;
  }
  if (!document) {
    return <div className="hunting-cv-preview__state"><b>Opening PDF pages…</b><span>Preparing a sharp, zoomable document preview.</span></div>;
  }

  return (
    <div className="hunting-pdf-pages" aria-label={`${document.numPages} page PDF preview`}>
      {Array.from({ length: document.numPages }, (_, index) => (
        <PdfCanvasPage key={index + 1} document={document} pageNumber={index + 1} />
      ))}
    </div>
  );
}

function PdfCanvasPage({ document, pageNumber }: { document: PDFDocumentProxy; pageNumber: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    let renderTask: RenderTask | null = null;
    document.getPage(pageNumber)
      .then((page) => {
        const canvas = canvasRef.current;
        if (!active || !canvas) return;
        const cssViewport = page.getViewport({ scale: 1.65 });
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const renderViewport = page.getViewport({ scale: 1.65 * pixelRatio });
        canvas.width = Math.floor(renderViewport.width);
        canvas.height = Math.floor(renderViewport.height);
        canvas.style.width = `${Math.floor(cssViewport.width)}px`;
        canvas.style.height = `${Math.floor(cssViewport.height)}px`;
        renderTask = page.render({ canvas, viewport: renderViewport });
        return renderTask.promise;
      })
      .catch((reason: unknown) => {
        if (active && reason instanceof Error && reason.name !== "RenderingCancelledException") setError(true);
      });
    return () => {
      active = false;
      renderTask?.cancel();
    };
  }, [document, pageNumber]);

  return (
    <figure className="hunting-pdf-page">
      {error ? <span>Page {pageNumber} could not be rendered.</span> : null}
      <canvas ref={canvasRef} aria-label={`PDF page ${pageNumber}`} />
      <figcaption>Page {pageNumber}</figcaption>
    </figure>
  );
}
