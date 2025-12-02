document.addEventListener('DOMContentLoaded', function () {
  const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxviDpRACUW8GMp3HfsIznOJCbXLcCIXI3qvjL-PcYZLYnIRbRAwcpMpLq1JSPfJfJ_dQ/exec'; // <-- tu /exec
  const TIPO_FIJO = 'DESCARGUE';

  let products = [];            // desde CSV de Drive
  let scannedUnits = {};        // contador por código_barra
  let globalUnitsScanned = 0;   // total escaneado
  let totalUnits = 0;           // total esperado
  let html5QrCode;              // cámara (opcional)
  let audioContext;
  let scanLock = false;
  let codigosCorrectos = [];    // [{codigo, hora}]
  let codigosIncorrectos = [];  // [{codigo, hora}]
  let barcodeTimeout;

  // ===== Audio =====
  function initializeAudioContext() {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  function playTone(freq, dur, type='sine', vol=1.0) {
    try {
      if (!audioContext) initializeAudioContext();
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = type; osc.frequency.setValueAtTime(freq, audioContext.currentTime);
      gain.gain.value = vol;
      osc.connect(gain); gain.connect(audioContext.destination);
      osc.start(); setTimeout(()=>osc.stop(), dur);
    } catch(e) {}
  }
  document.body.addEventListener('click', initializeAudioContext, { once: true });

  // ===== Persistencia (opcional) =====
  function saveProgressToLocalStorage() {
    const data = {
      products, scannedUnits, globalUnitsScanned, totalUnits,
      codigosCorrectos, codigosIncorrectos
    };
    const compressed = LZString.compress(JSON.stringify(data));
    localStorage.setItem('scanProgress', compressed);
  }
  function restoreProgressFromLocalStorage() {
    const saved = localStorage.getItem('scanProgress');
    if (!saved) return;
    const json = LZString.decompress(saved);
    if (!json) return;
    try {
      const d = JSON.parse(json);
      products = d.products || [];
      scannedUnits = d.scannedUnits || {};
      globalUnitsScanned = d.globalUnitsScanned || 0;
      totalUnits = d.totalUnits || 0;
      codigosCorrectos = d.codigosCorrectos || [];
      codigosIncorrectos = d.codigosIncorrectos || [];
      updateScannedList();
      updateGlobalCounter();
    } catch(e) {}
  }
  restoreProgressFromLocalStorage();

  // ===== Cargar archivo (cliente) desde Drive (CSV) =====
  document.getElementById('cargar-desde-drive').addEventListener('click', () => {
    const fileId = document.getElementById('archivo-select').value;
    if (!fileId) { alert("Selecciona un cliente para cargar su archivo."); return; }

    const exportUrl = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=csv`;
    fetch(exportUrl)
      .then(r => { if (!r.ok) throw new Error("No se pudo acceder al archivo desde Drive."); return r.text(); })
      .then(csvText => {
        Papa.parse(csvText, {
          header: true, skipEmptyLines: true,
          complete: (results) => {
            products = results.data.map(item => ({
              codigo_barra: (item['codigo_barra'] || '').trim(),
              cantidad: parseInt((item['cantidad'] || '0').trim(), 10),
              ciudad: (item['ciudad'] || '').trim(),
              codigos_validos: [
                (item['codigo_barra'] || '').trim(),
                ...((item['codigos_adicionales'] || '').split(',').map(s => s.trim()).filter(Boolean))
              ],
              scannedSubcodes: [],
              noSufijoCount: 0
            }));

            scannedUnits = {};
            globalUnitsScanned = 0;
            totalUnits = products.reduce((acc, p) => acc + (p.cantidad || 0), 0);
            products.forEach(p => { scannedUnits[p.codigo_barra] = 0; });

            updateScannedList();
            updateGlobalCounter();
            saveProgressToLocalStorage();

            // Bloquear selector (cliente cargado)
            const sel = document.getElementById('archivo-select');
            sel.disabled = true;
            document.getElementById('cargar-desde-drive').disabled = true;

            // Mostrar nombre de cliente
            const option = sel.selectedOptions[0];
            const box = document.getElementById('cliente-cargado');
            box.innerText = `📦 Cliente cargado: ${option.text}`;
            box.style.display = 'block';

            alert("Archivo cargado correctamente.");
          }
        });
      })
      .catch(err => alert("Error al cargar el archivo: " + err.message));
  });

  // ===== Escáner por input (pistola) =====
  document.getElementById('barcodeInput').addEventListener('input', () => {
    const val = document.getElementById('barcodeInput').value.trim();
    clearTimeout(barcodeTimeout);
    if (val !== '') {
      barcodeTimeout = setTimeout(() => {
        handleBarcodeScan(val);
        clearBarcodeInput();
      }, 1000);
    }
  });
  function clearBarcodeInput() { document.getElementById('barcodeInput').value = ''; }

  function obtenerHoraFormateada() {
    const d = new Date();
    let h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12; h = h ? h : 12;
    const pad = (n) => n < 10 ? '0' + n : n;
    return `${h}:${pad(m)}:${pad(s)} ${ampm}`;
  }

  // ===== Lógica de escaneo con comparación =====
  function handleBarcodeScan(scannedCode) {
    const parts = String(scannedCode || '').split('-');
    let main = (parts[0] || '').trim();
    main = main.replace(/^0+/, ''); // sin ceros iniciales
    const sub = (parts[1] || '').trim();
    const now = obtenerHoraFormateada();

    const p = products.find(x => x.codigos_validos.includes(main));

    if (p) {
      const cur = scannedUnits[p.codigo_barra] || 0;
      if (cur >= p.cantidad) {
        alert(`El producto ${main} ya alcanzó la cantidad total (${p.cantidad}).`);
        playTone(220, 400, 'square'); clearBarcodeInput(); return;
      }

      // Registrar en correctos
      codigosCorrectos.push({ codigo: main, hora: now });

      if (sub === '' || p.cantidad === 1) {
        if (p.noSufijoCount < p.cantidad) {
          p.noSufijoCount += 1;
          scannedUnits[p.codigo_barra] += 1;
          globalUnitsScanned += 1;
          playTone(440, 180, 'sine');
        } else {
          alert(`El código ${main} ya fue escaneado ${p.cantidad} vez/veces.`);
          playTone(220, 400, 'square');
        }
      } else {
        if (!p.scannedSubcodes.includes(sub)) {
          p.scannedSubcodes.push(sub);
          scannedUnits[p.codigo_barra] += 1;
          globalUnitsScanned += 1;
          playTone(440, 180, 'sine');
        } else {
          alert(`El subcódigo -${sub} de ${main} ya fue escaneado.`);
          playTone(220, 400, 'square');
        }
      }

      updateScannedList(p.codigo_barra);
      updateGlobalCounter();
      saveProgressToLocalStorage();

    } else {
      playTone(220, 400, 'square');
      alert("El código escaneado no coincide con ningún producto.");
      codigosIncorrectos.push({ codigo: main, hora: now });
    }
    clearBarcodeInput();
  }

  // ===== UI =====
  function updateScannedList(scannedCode = '') {
    const ul = document.getElementById('scanned-list');
    ul.innerHTML = '';

    const sorted = products.slice().sort((a,b) => {
      if (a.codigo_barra === scannedCode) return -1;
      if (b.codigo_barra === scannedCode) return 1;
      return 0;
    });

    sorted.forEach(p => {
      const done = scannedUnits[p.codigo_barra] || 0;
      const pct = p.cantidad ? (done / p.cantidad) * 100 : 0;
      let cls = done === p.cantidad ? 'status-complete' : (done > 0 ? 'status-warning' : 'status-incomplete');
      const li = document.createElement('li');
      li.className = cls;
      li.innerHTML = `
        <span><strong>Códigos Adicionales:</strong> ${p.codigos_validos.join(', ')}</span><br>
        <span class="city"><strong>Ciudad:</strong> ${p.ciudad}</span>
        <div class="progress-bar"><div class="progress-bar-inner" style="width:${pct}%"></div></div>
        <span class="progress-text">${done} de ${p.cantidad} unidades escaneadas</span>
      `;
      ul.appendChild(li);
    });
  }
  function updateGlobalCounter() {
    document.getElementById('global-counter').innerText =
      `Unidades descargadas: ${globalUnitsScanned} de ${totalUnits}`;
  }

  // ===== Abrir/Cerrar modal =====
  document.getElementById('finalizar-descarga').addEventListener('click', () => {
    const m = document.getElementById('modal');
    m.style.display = 'flex';
    document.getElementById('fecha').value = new Date().toLocaleDateString();
  });
  document.getElementById('cerrar-modal').addEventListener('click', () => {
    document.getElementById('modal').style.display = 'none';
  });

  // ===== Terminar proceso =====
  document.getElementById('terminar-proceso').addEventListener('click', function () {
    const ok = confirm("¿Estás seguro de que deseas finalizar el proceso? Esto eliminará todos los datos escaneados.");
    if (!ok) return;

    localStorage.removeItem('scanProgress');
    products = [];
    scannedUnits = {};
    globalUnitsScanned = 0;
    totalUnits = 0;
    codigosCorrectos = [];
    codigosIncorrectos = [];

    const sel = document.getElementById('archivo-select');
    sel.disabled = false; sel.value = "";
    document.getElementById('cargar-desde-drive').disabled = false;

    const box = document.getElementById('cliente-cargado');
    box.innerText = ''; box.style.display = 'none';

    updateScannedList();
    updateGlobalCounter();
    saveProgressToLocalStorage();

    alert('Proceso finalizado. Los datos se han eliminado.');
  });

  // ===== Enviar comparativo a Google Sheets (NO Excel) =====
  document.getElementById('generar-reporte').addEventListener('click', async () => {
    const placa = (document.getElementById('placa').value || '').trim();
    const remitente = (document.getElementById('remitente').value || '').trim();
    const fecha = (document.getElementById('fecha').value || '').trim();

    if (!placa || !remitente) {
      alert("Por favor, completa Placa y Remitente.");
      return;
    }
    if (!products.length) {
      alert("Primero carga el archivo del cliente.");
      return;
    }

    // Construir RESUMEN (3 columnas): Código, UnidadesEsc (X/Y), Ciudad
    const resumen = products.map(p => ({
      codigoBarra: p.codigo_barra,
      unidadesEsc: `${scannedUnits[p.codigo_barra] || 0} / ${p.cantidad || 0}`,
      ciudad: p.ciudad
    }));

    // Correctos / Incorrectos (n, codigo, hora)
    const correctos = codigosCorrectos.map((r, i) => ({ n: i + 1, codigo: r.codigo, hora: r.hora }));
    const incorrectos = codigosIncorrectos.map((r, i) => ({ n: i + 1, codigo: r.codigo, hora: r.hora }));

    // Armar payload para tu Code.gs (comparativo apilado en 3 columnas)
    const payload = {
      meta: {
        placa,
        tipo: TIPO_FIJO,              // DESCARGUE fijo
        remitente,
        fecha,                        // informativo; el backend usa la regla 6am
        total_unidades: globalUnitsScanned,
        timestamp_envio: new Date().toISOString()
      },
      comparativo: { resumen, correctos, incorrectos }
    };

    // Enviar
    const btn = document.getElementById('generar-reporte');
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = 'Enviando...';

    try {
      if (!/^https?:\/\/script\.google\.com\/macros\//.test(SCRIPT_URL)) {
        throw new Error('SCRIPT_URL inválida. Configura tu URL /exec.');
      }

      const resp = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, // evitar preflight CORS
        body: JSON.stringify(payload)
      });
      if (!resp.ok) {
        const t = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${t}`);
      }
      const result = await resp.json().catch(() => ({}));
      alert(`Enviado a Google Sheets.\nHoja: ${result.sheet || '-'} | Col inicial: ${result.startCol || '-'} | Modo: ${result.mode || 'comparativo'}`);

      // Cerrar modal
      document.getElementById('modal').style.display = 'none';

      // (Opcional) limpiar después de enviar:
      // products = []; scannedUnits = {}; globalUnitsScanned = 0; totalUnits = 0;
      // codigosCorrectos = []; codigosIncorrectos = [];
      // updateScannedList(); updateGlobalCounter(); saveProgressToLocalStorage();

    } catch (err) {
      console.error(err);
      alert('No se pudo enviar a Google Sheets. Revisa la consola para más detalles.');
    } finally {
      btn.disabled = false; btn.textContent = original;
    }
  });
});
