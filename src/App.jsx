import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import JSZip from 'jszip';

const DB_NAME = 'qr-label-studio-db';
const DB_VERSION = 1;
const DEFAULT_WIDTH_MM = '50';

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('This browser does not support IndexedDB. Try a current version of Chrome, Edge, or Firefox.'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('labels')) db.createObjectStore('labels', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open local storage.'));
  });
}

async function dbRequest(storeName, mode, operation, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let request;
    try {
      if (operation === 'getAll') request = store.getAll();
      else if (operation === 'get') request = store.get(value);
      else if (operation === 'put') request = store.put(value);
      else if (operation === 'delete') request = store.delete(value);
      else throw new Error(`Unsupported database operation: ${operation}`);
    } catch (error) {
      db.close();
      reject(error);
      return;
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not access local storage.'));
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error || new Error('The local storage transaction failed.'));
    };
  });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the logo image.'));
    reader.readAsDataURL(blob);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load an image required for the label.'));
    image.src = src;
  });
}

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = PNG_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint32BE(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

async function addPngDpiMetadata(blob, dpi = 300) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !signature.every((value, index) => bytes[index] === value)) return blob;
  const pixelsPerMeter = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  writeUint32BE(chunk, 0, 9);
  chunk.set([112, 72, 89, 115], 4); // pHYs
  writeUint32BE(chunk, 8, pixelsPerMeter);
  writeUint32BE(chunk, 12, pixelsPerMeter);
  chunk[16] = 1; // pixels per meter
  writeUint32BE(chunk, 17, pngCrc32(chunk.subarray(4, 17)));

  const parts = [bytes.slice(0, 8)];
  let offset = 8;
  let inserted = false;
  while (offset + 12 <= bytes.length) {
    const length = (bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
    const end = offset + 12 + length;
    if (end > bytes.length) return blob;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type !== 'pHYs') parts.push(bytes.slice(offset, end));
    if (type === 'IHDR' && !inserted) {
      parts.push(chunk);
      inserted = true;
    }
    offset = end;
    if (type === 'IEND') break;
  }
  if (!inserted) return blob;
  return new Blob(parts, { type: 'image/png' });
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error('The browser could not create the PNG file.'));
        return;
      }
      try {
        resolve(await addPngDpiMetadata(blob, 300));
      } catch (error) {
        reject(error);
      }
    }, 'image/png');
  });
}

function wrapText(ctx, text, maxWidth) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function makeStickerBlob(label) {
  const content = String(label.content || '').trim();
  if (!content) throw new Error('Enter the URL or text to encode first.');
  const widthMm = Math.min(100, Math.max(20, Number(label.widthMm) || 50));
  const width = Math.round((widthMm / 25.4) * 300);
  const qrSize = Math.round(width * 0.90);
  const qrDataUrl = await QRCode.toDataURL(content, {
    errorCorrectionLevel: 'H',
    margin: 4,
    width: qrSize,
    color: { dark: '#111111', light: '#FFFFFF' },
  });
  const qrImage = await loadImage(qrDataUrl);

  let logoImage = null;
  if (label.useLogo && label.logoBlob) {
    const logoDataUrl = await blobToDataUrl(label.logoBlob);
    logoImage = await loadImage(logoDataUrl);
  }

  const marginX = Math.round(width * 0.08);
  const topMargin = Math.round(width * 0.035);
  const gap = Math.round(width * 0.035);
  const fontSize = Math.max(16, Math.round(width * 0.061));
  const caption = String(label.name || '').trim() || ' ';
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d');
  measureCtx.font = `700 ${fontSize}px Arial, Helvetica, sans-serif`;
  const lines = wrapText(measureCtx, caption, width - marginX * 2);
  const lineHeight = Math.round(fontSize * 1.22);
  const captionHeight = lines.length * lineHeight;
  const bottomMargin = Math.round(width * 0.034);
  const height = topMargin + qrSize + gap + captionHeight + bottomMargin;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);
  const qrX = Math.round((width - qrSize) / 2);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(qrImage, qrX, topMargin, qrSize, qrSize);

  if (logoImage) {
    const maxLogoSize = Math.round(qrSize * 0.19);
    const ratio = Math.min(maxLogoSize / logoImage.width, maxLogoSize / logoImage.height);
    const logoWidth = Math.max(1, Math.round(logoImage.width * ratio));
    const logoHeight = Math.max(1, Math.round(logoImage.height * ratio));
    const padding = Math.round(qrSize * 0.025);
    const boxWidth = logoWidth + padding * 2;
    const boxHeight = logoHeight + padding * 2;
    const boxX = Math.round(width / 2 - boxWidth / 2);
    const boxY = Math.round(topMargin + qrSize / 2 - boxHeight / 2);
    ctx.imageSmoothingEnabled = true;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight);
    ctx.drawImage(logoImage, Math.round(width / 2 - logoWidth / 2), Math.round(topMargin + qrSize / 2 - logoHeight / 2), logoWidth, logoHeight);
  }

  ctx.fillStyle = '#111111';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = `700 ${fontSize}px Arial, Helvetica, sans-serif`;
  ctx.imageSmoothingEnabled = true;
  lines.forEach((line, index) => {
    ctx.fillText(line, width / 2, topMargin + qrSize + gap + index * lineHeight, width - marginX * 2);
  });
  return canvasToBlob(canvas);
}

async function makeThumbnailDataUrl(label) {
  const qrDataUrl = await QRCode.toDataURL(String(label.content || ''), {
    errorCorrectionLevel: 'H', margin: 4, width: 144,
    color: { dark: '#111111', light: '#FFFFFF' },
  });
  const qrImage = await loadImage(qrDataUrl);
  const canvas = document.createElement('canvas');
  canvas.width = 152;
  canvas.height = 152;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 152, 152);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(qrImage, 4, 4, 144, 144);
  if (label.useLogo && label.logoBlob) {
    const logo = await loadImage(await blobToDataUrl(label.logoBlob));
    const maxSize = 144 * 0.19;
    const ratio = Math.min(maxSize / logo.width, maxSize / logo.height);
    const w = Math.max(1, Math.round(logo.width * ratio));
    const h = Math.max(1, Math.round(logo.height * ratio));
    const pad = 4;
    ctx.fillStyle = '#fff';
    ctx.fillRect(76 - w / 2 - pad, 76 - h / 2 - pad, w + pad * 2, h + pad * 2);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(logo, 76 - w / 2, 76 - h / 2, w, h);
  }
  return canvas.toDataURL('image/png');
}

function LabelThumbnail({ label, onOpen }) {
  const [thumbnail, setThumbnail] = useState('');
  useEffect(() => {
    let active = true;
    makeThumbnailDataUrl(label).then((url) => { if (active) setThumbnail(url); }).catch(() => {});
    return () => { active = false; };
  }, [label.id, label.content, label.useLogo, label.logoBlob]);
  return (
    <button className="label-thumbnail" type="button" onClick={onOpen} title={`Edit ${label.name}`}>
      {thumbnail ? <img className="label-thumbnail-qr" src={thumbnail} alt={`QR code for ${label.name}`} /> : <span className="thumbnail-loading">Generating QR…</span>}
      <strong>{label.name}</strong>
    </button>
  );
}

function cleanFilename(value) {
  const cleaned = String(value || 'qr-label')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'qr-label';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function formatDate(value) {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return '';
  }
}

export default function App() {
  const [labels, setLabels] = useState([]);
  const [logoBlob, setLogoBlob] = useState(null);
  const [formLogoBlob, setFormLogoBlob] = useState(null);
  const [logoUrl, setLogoUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('create');
  const [content, setContent] = useState('');
  const [name, setName] = useState('');
  const [widthMm, setWidthMm] = useState(DEFAULT_WIDTH_MM);
  const [useLogo, setUseLogo] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const logoInputRef = useRef(null);
  const importInputRef = useRef(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [savedLabels, savedLogo] = await Promise.all([
          dbRequest('labels', 'readonly', 'getAll'),
          dbRequest('assets', 'readonly', 'get', 'defaultLogo'),
        ]);
        if (active) {
          setLabels(savedLabels.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
          setLogoBlob(savedLogo?.blob || null);
          setFormLogoBlob(savedLogo?.blob || null);
        }
      } catch (err) {
        if (active) setError(err.message || 'Could not load saved data.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!logoBlob) {
      setLogoUrl('');
      return undefined;
    }
    const url = URL.createObjectURL(logoBlob);
    setLogoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [logoBlob]);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';
    const timer = window.setTimeout(async () => {
      if (!String(content).trim()) {
        setPreviewUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return '';
        });
        return;
      }
      try {
        const blob = await makeStickerBlob({ content, name, widthMm, useLogo, logoBlob: formLogoBlob });
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl((old) => {
          if (old) URL.revokeObjectURL(old);
          return objectUrl;
        });
      } catch {
        // Keep the form usable while the user is typing an incomplete value.
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [content, name, widthMm, useLogo, formLogoBlob]);

  const filteredLabels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return labels;
    return labels.filter((label) => `${label.name} ${label.content}`.toLowerCase().includes(query));
  }, [labels, search]);

  const selectedCount = useMemo(() => selected.size, [selected]);

  const refreshLabels = useCallback(async () => {
    const all = await dbRequest('labels', 'readonly', 'getAll');
    all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    setLabels(all);
  }, []);

  const persistLogo = async (file) => {
    setError('');
    setNotice('');
    if (!file) return;
    if (file.type !== 'image/png') {
      setError('Please upload a PNG logo.');
      if (logoInputRef.current) logoInputRef.current.value = '';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('The logo must be 5 MB or smaller.');
      if (logoInputRef.current) logoInputRef.current.value = '';
      return;
    }
    try {
      await dbRequest('assets', 'readwrite', 'put', { id: 'defaultLogo', blob: file, updatedAt: Date.now() });
      setLogoBlob(file);
      setFormLogoBlob(file);
      setUseLogo(true);
      setNotice('Logo saved in this browser. New labels can reuse it automatically.');
    } catch (err) {
      setError(err.message || 'Could not save the logo.');
    } finally {
      if (logoInputRef.current) logoInputRef.current.value = '';
    }
  };

  const clearForm = () => {
    setEditingId(null);
    setContent('');
    setName('');
    setWidthMm(DEFAULT_WIDTH_MM);
    setUseLogo(Boolean(logoBlob));
    setFormLogoBlob(logoBlob);
    setError('');
    setNotice('');
  };


  const saveLabel = async (alsoDownload = false) => {
    setError('');
    setNotice('');
    if (!content.trim()) {
      setError('Enter the URL or text to encode.');
      return;
    }
    if (!name.trim()) {
      setError('Enter a bold label caption.');
      return;
    }
    setBusy(true);
    try {
      const now = Date.now();
      const old = editingId ? labels.find((item) => item.id === editingId) : null;
      const label = {
        id: editingId || crypto.randomUUID(),
        content: content.trim(),
        name: name.trim(),
        widthMm: String(widthMm),
        useLogo: Boolean(useLogo && formLogoBlob),
        logoBlob: useLogo && formLogoBlob ? formLogoBlob : null,
        createdAt: old?.createdAt || now,
        updatedAt: now,
      };
      if (alsoDownload) {
        const png = await makeStickerBlob(label);
        downloadBlob(png, `${cleanFilename(label.name)}.png`);
      }
      await dbRequest('labels', 'readwrite', 'put', label);
      await refreshLabels();
      setEditingId(label.id);
      setNotice(alsoDownload ? 'Label saved and PNG exported.' : 'Label saved to your local library.');
      setTab('library');
    } catch (err) {
      setError(err.message || 'Could not save this label.');
    } finally {
      setBusy(false);
    }
  };

  const editLabel = (label) => {
    setEditingId(label.id);
    setContent(label.content || '');
    setName(label.name || '');
    setWidthMm(String(label.widthMm || DEFAULT_WIDTH_MM));
    setUseLogo(Boolean(label.useLogo && label.logoBlob));
    setFormLogoBlob(label.logoBlob || logoBlob || null);
    setError('');
    setNotice(`Editing “${label.name}”. Save to update this label.`);
    setTab('create');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const deleteLabel = async (label) => {
    if (!window.confirm(`Delete “${label.name}”? This cannot be undone.`)) return;
    try {
      await dbRequest('labels', 'readwrite', 'delete', label.id);
      setSelected((old) => {
        const next = new Set(old);
        next.delete(label.id);
        return next;
      });
      if (editingId === label.id) clearForm();
      await refreshLabels();
      setNotice(`Deleted “${label.name}”.`);
      setError('');
    } catch (err) {
      setError(err.message || 'Could not delete the label.');
    }
  };

  const exportOne = async (label) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const blob = await makeStickerBlob(label);
      downloadBlob(blob, `${cleanFilename(label.name)}.png`);
      setNotice(`Exported ${label.name}.`);
    } catch (err) {
      setError(err.message || `Could not export ${label.name}.`);
    } finally {
      setBusy(false);
    }
  };

  const exportZip = async () => {
    const chosen = labels.filter((label) => selected.has(label.id));
    if (!chosen.length) {
      setError('Select at least one label to export.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice(`Preparing ${chosen.length} label${chosen.length === 1 ? '' : 's'}…`);
    try {
      const zip = new JSZip();
      const usedNames = new Map();
      for (let index = 0; index < chosen.length; index += 1) {
        const label = chosen[index];
        setNotice(`Rendering ${index + 1} of ${chosen.length}: ${label.name}`);
        const blob = await makeStickerBlob(label);
        const base = cleanFilename(label.name);
        const count = (usedNames.get(base) || 0) + 1;
        usedNames.set(base, count);
        const filename = count === 1 ? `${base}.png` : `${base}-${count}.png`;
        zip.file(filename, blob);
      }
      setNotice('Compressing ZIP…');
      const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      downloadBlob(zipBlob, `qr-labels-${new Date().toISOString().slice(0, 10)}.zip`);
      setNotice(`Exported ${chosen.length} label${chosen.length === 1 ? '' : 's'} as a ZIP file.`);
    } catch (err) {
      setError(err.message || 'Could not create the ZIP archive.');
      setNotice('');
    } finally {
      setBusy(false);
    }
  };

  const toggleAllVisible = (checked) => {
    setSelected((old) => {
      const next = new Set(old);
      filteredLabels.forEach((label) => checked ? next.add(label.id) : next.delete(label.id));
      return next;
    });
  };

  const exportLibraryBackup = async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const backup = {
        format: 'qr-label-studio-backup',
        version: 1,
        exportedAt: new Date().toISOString(),
        defaultLogo: logoBlob ? { type: logoBlob.type || 'image/png', data: await blobToDataUrl(logoBlob) } : null,
        labels: await Promise.all(labels.map(async (label) => ({
          ...label,
          logoBlob: label.logoBlob ? { type: label.logoBlob.type || 'image/png', data: await blobToDataUrl(label.logoBlob) } : null,
        }))),
      };
      downloadBlob(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }), `qr-label-studio-backup-${new Date().toISOString().slice(0, 10)}.json`);
      setNotice('Backup exported. Keep this JSON file somewhere safe.');
    } catch (err) {
      setError(err.message || 'Could not create a backup.');
    } finally {
      setBusy(false);
    }
  };

  const importLibraryBackup = async (file) => {
    if (!file) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed.format !== 'qr-label-studio-backup' || !Array.isArray(parsed.labels)) {
        throw new Error('This file is not a QR Label Studio backup.');
      }
      const toBlob = async (item) => item?.data ? await (await fetch(item.data)).blob() : null;
      if (parsed.defaultLogo?.data) {
        const logo = await toBlob(parsed.defaultLogo);
        if (logo && logo.type === 'image/png') {
          await dbRequest('assets', 'readwrite', 'put', { id: 'defaultLogo', blob: logo, updatedAt: Date.now() });
          setLogoBlob(logo);
        }
      }
      let imported = 0;
      for (const item of parsed.labels) {
        if (!item.id || !item.content || !item.name) continue;
        const logo = item.logoBlob?.data ? await toBlob(item.logoBlob) : null;
        const safeLabel = { ...item, widthMm: String(item.widthMm || DEFAULT_WIDTH_MM), logoBlob: logo, updatedAt: item.updatedAt || Date.now(), createdAt: item.createdAt || Date.now() };
        await dbRequest('labels', 'readwrite', 'put', safeLabel);
        imported += 1;
      }
      await refreshLabels();
      setNotice(`Imported ${imported} label${imported === 1 ? '' : 's'} from backup.`);
      setTab('library');
    } catch (err) {
      setError(err.message || 'Could not import this backup.');
    } finally {
      setBusy(false);
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  const selectVisibleAllChecked = filteredLabels.length > 0 && filteredLabels.every((label) => selected.has(label.id));

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true"><span /></div>
        <div className="brand-copy">
          <h1>QR Label Studio</h1>
          <p>Generate, organize, and print QR labels.</p>
        </div>
        <div className="local-badge"><span className="status-dot" /> Stored locally</div>
      </header>

      <nav className="tabs" aria-label="Main sections">
        <button className={tab === 'create' ? 'tab active' : 'tab'} onClick={() => setTab('create')}>Create label</button>
        <button className={tab === 'library' ? 'tab active' : 'tab'} onClick={() => setTab('library')}>Label library <span className="count-pill">{labels.length}</span></button>
      </nav>

      {(error || notice) && (
        <div className={error ? 'message error-message' : 'message success-message'} role="status">
          <span>{error || notice}</span>
          <button className="message-close" aria-label="Dismiss message" onClick={() => { setError(''); setNotice(''); }}>×</button>
        </div>
      )}

      {loading ? <div className="loading-state">Loading your local label library…</div> : (
        <>
          {tab === 'create' && (
            <section className="create-layout">
              <div className="panel editor-panel">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">LABEL EDITOR</p>
                    <h2>{editingId ? 'Edit label' : 'Create a label'}</h2>
                  </div>
                  {editingId && <span className="editing-pill">Editing saved label</span>}
                </div>
                <form onSubmit={(event) => { event.preventDefault(); saveLabel(false); }}>
                  <label className="field-label" htmlFor="qr-content">QR content <span className="required">*</span></label>
                  <textarea id="qr-content" value={content} onChange={(event) => setContent(event.target.value)} placeholder="Enter a URL, text, or item identifier" rows={3} required />
                  <p className="field-help">This is the exact text encoded inside the QR code.</p>

                  <label className="field-label" htmlFor="label-caption">Caption <span className="required">*</span></label>
                  <input id="label-caption" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. ASSET-001" maxLength={180} required />
                  <p className="field-help">Printed in bold underneath the QR code. Long captions wrap automatically.</p>

                  <div className="field-row">
                    <div className="field-group">
                      <label className="field-label" htmlFor="sticker-width">Sticker width</label>
                      <select id="sticker-width" value={widthMm} onChange={(event) => setWidthMm(event.target.value)}>
                        <option value="30">30 mm</option>
                        <option value="40">40 mm</option>
                        <option value="50">50 mm</option>
                        <option value="60">60 mm</option>
                        <option value="70">70 mm</option>
                        <option value="80">80 mm</option>
                        <option value="100">100 mm</option>
                      </select>
                    </div>
                    <div className="field-group logo-option-group">
                      <span className="field-label">Logo on label</span>
                      <label className="switch-row">
                        <input type="checkbox" checked={useLogo} onChange={(event) => setUseLogo(event.target.checked)} disabled={!formLogoBlob} />
                        <span>Use saved logo</span>
                      </label>
                    </div>
                  </div>

                  <div className="logo-card">
                    <div className="logo-preview">
                      {logoUrl ? <img src={logoUrl} alt="Saved logo" /> : <span className="logo-placeholder">PNG</span>}
                    </div>
                    <div className="logo-card-copy">
                      <strong>{logoBlob ? 'Saved logo' : 'No logo saved'}</strong>
                      <span>{logoBlob ? 'Reused for new labels in this browser.' : 'Upload a transparent PNG if you need a logo.'}</span>
                      <button className="text-button" type="button" onClick={() => logoInputRef.current?.click()}>{logoBlob ? 'Replace PNG logo' : 'Upload PNG logo'}</button>
                      <input ref={logoInputRef} className="visually-hidden" type="file" accept="image/png,.png" onChange={(event) => persistLogo(event.target.files?.[0])} />
                    </div>
                    {logoBlob && <button className="icon-button remove-logo" type="button" title="Remove saved logo" onClick={async () => {
                      await dbRequest('assets', 'readwrite', 'delete', 'defaultLogo');
                      setLogoBlob(null);
                      if (!editingId) setFormLogoBlob(null);
                      setUseLogo(false);
                      setNotice('Saved logo removed. Existing labels retain their own logo copies.');
                    }}>×</button>}
                  </div>
                  <p className="field-help">PNG only, up to 5 MB. Logos are stored in this browser and never uploaded to a server.</p>

                  <div className="form-actions">
                    <button className="button primary" type="submit" disabled={busy}>{busy ? 'Working…' : editingId ? 'Save changes' : 'Save label'}</button>
                    <button className="button secondary" type="button" disabled={busy} onClick={() => saveLabel(true)}>{busy ? 'Working…' : 'Save + export PNG'}</button>
                    {editingId && <button className="button subtle" type="button" onClick={clearForm}>New label</button>}
                  </div>
                </form>
              </div>

              <aside className="panel preview-panel">
                <div className="panel-heading">
                  <div>
                    <p className="eyebrow">LIVE PREVIEW</p>
                    <h2>Sticker preview</h2>
                  </div>
                  <span className="preview-size">{widthMm} mm wide</span>
                </div>
                <div className="sticker-preview-stage">
                  {previewUrl ? <img className="sticker-preview-image" src={previewUrl} alt="Preview of generated QR sticker" /> : (
                    <div className="empty-preview">
                      <div className="empty-qr-icon">▦</div>
                      <strong>Your sticker appears here</strong>
                      <span>Enter QR content to preview the label.</span>
                    </div>
                  )}
                </div>
                <div className="preview-specs">
                  <div><span>Format</span><strong>PNG</strong></div>
                  <div><span>Render quality</span><strong>300 DPI equivalent</strong></div>
                  <div><span>QR correction</span><strong>High (H)</strong></div>
                </div>
                <p className="preview-note">The PNG is rendered at approximately 300 pixels per inch for the selected width. Printer software may still need to be set to the intended physical size.</p>
              </aside>
            </section>
          )}

          {tab === 'library' && (
            <section className="library-panel panel">
              <div className="library-heading">
                <div>
                  <p className="eyebrow">YOUR COLLECTION</p>
                  <h2>Label library</h2>
                  <p className="muted">Saved on this device. Open a label to edit it or select several to export together.</p>
                </div>
                <button className="button primary" onClick={() => { clearForm(); setTab('create'); }}>＋ New label</button>
              </div>
              <div className="library-toolbar">
                <div className="search-box"><span aria-hidden="true">⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search caption or QR content" aria-label="Search labels" /></div>
                <div className="toolbar-actions">
                  <button className="button secondary" onClick={exportLibraryBackup} disabled={busy}>Export backup</button>
                  <button className="button secondary" onClick={() => importInputRef.current?.click()} disabled={busy}>Import backup</button>
                  <input ref={importInputRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => importLibraryBackup(event.target.files?.[0])} />
                </div>
              </div>

              {labels.length > 0 && (
                <div className="bulk-toolbar">
                  <label className="check-label"><input type="checkbox" checked={selectVisibleAllChecked} onChange={(event) => toggleAllVisible(event.target.checked)} /> Select all visible</label>
                  <span className="selected-counter">{selectedCount} selected</span>
                  <div className="bulk-actions">
                    <button className="button secondary small" onClick={() => setSelected(new Set())} disabled={!selectedCount || busy}>Clear selection</button>
                    <button className="button primary small" onClick={exportZip} disabled={!selectedCount || busy}>{busy ? 'Exporting…' : `Export ZIP${selectedCount ? ` (${selectedCount})` : ''}`}</button>
                  </div>
                </div>
              )}

              {filteredLabels.length === 0 ? (
                <div className="empty-library">
                  <div className="empty-library-icon">▤</div>
                  <h3>{labels.length ? 'No matching labels' : 'No saved labels yet'}</h3>
                  <p>{labels.length ? 'Try a different search.' : 'Create a label first. Saved labels will appear here for editing and bulk export.'}</p>
                  {!labels.length && <button className="button primary" onClick={() => { clearForm(); setTab('create'); }}>Create first label</button>}
                </div>
              ) : (
                <div className="label-grid">
                  {filteredLabels.map((label) => (
                    <article className={`label-card ${selected.has(label.id) ? 'selected' : ''}`} key={label.id}>
                      <div className="label-card-top">
                        <label className="check-label card-check"><input type="checkbox" checked={selected.has(label.id)} onChange={(event) => setSelected((old) => {
                          const next = new Set(old);
                          if (event.target.checked) next.add(label.id); else next.delete(label.id);
                          return next;
                        })} /><span className="sr-only">Select {label.name}</span></label>
                        <span className="saved-date">{formatDate(label.updatedAt)}</span>
                      </div>
                      <LabelThumbnail label={label} onOpen={() => editLabel(label)} />
                      <div className="label-card-content">
                        <p className="label-value" title={label.content}>{label.content}</p>
                        <div className="label-meta"><span>{label.widthMm || DEFAULT_WIDTH_MM} mm wide</span><span>{label.useLogo && label.logoBlob ? 'Logo' : 'No logo'}</span></div>
                      </div>
                      <div className="label-card-actions">
                        <button className="button secondary small" onClick={() => editLabel(label)} disabled={busy}>Edit</button>
                        <button className="button secondary small" onClick={() => exportOne(label)} disabled={busy}>PNG ↓</button>
                        <button className="icon-button delete-button" title={`Delete ${label.name}`} aria-label={`Delete ${label.name}`} onClick={() => deleteLabel(label)} disabled={busy}>×</button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              <div className="library-footer"><span>{labels.length} saved label{labels.length === 1 ? '' : 's'}</span><span>Library data stays in this browser profile.</span></div>
            </section>
          )}
        </>
      )}

      <footer className="app-footer">
        <span>QR Label Studio</span>
        <span>Local-first · No account · No backend</span>
      </footer>
    </main>
  );
}
