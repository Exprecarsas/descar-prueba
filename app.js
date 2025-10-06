document.addEventListener('DOMContentLoaded', function () {
    let products = []; // Lista de productos cargados desde el CSV
    let scannedUnits = {}; // Unidades escaneadas por cada producto
    let globalUnitsScanned = 0; // Contador global de unidades escaneadas
    let totalUnits = 0; // Cantidad total de unidades esperadas
    let html5QrCode; // Objeto para manejar el escáner
    let audioContext; // Contexto de audio para generar tonos
    let scanLock = false; // Variable para bloquear el escaneo temporalmente
    let codigosCorrectos = []; // Códigos que coinciden con los productos
    let codigosIncorrectos = []; // Códigos que no coinciden con los productos
    let barcodeTimeout; // Variable para almacenar el temporizador

    // Inicializar contexto de audio para generar tonos
    function initializeAudioContext() {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
    }

    // Generar un tono con Web Audio API
    function playTone(frequency, duration, type = 'sine', volume = 1.5) {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        oscillator.type = type;
        oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);
        gainNode.gain.value = volume;
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        oscillator.start();
        setTimeout(() => {
            oscillator.stop();
        }, duration);
    }

    // Habilitar contexto de audio al hacer clic en el primer evento (para dispositivos móviles)
    document.body.addEventListener('click', initializeAudioContext, { once: true });

    // Guardar progreso comprimido en localStorage
    function saveProgressToLocalStorage() {
        const progressData = {
            products: products,
            scannedUnits: scannedUnits,
            globalUnitsScanned: globalUnitsScanned,
            totalUnits: totalUnits,
            codigosCorrectos: codigosCorrectos, // Guardar códigos correctos
            codigosIncorrectos: codigosIncorrectos // Guardar códigos incorrectos
        };
        // Comprimir los datos antes de guardarlos
        const compressedData = LZString.compress(JSON.stringify(progressData));
        localStorage.setItem('scanProgress', compressedData); // Guardar los datos comprimidos en localStorage
        console.log("Datos comprimidos guardados en localStorage:", compressedData); // Verificar en consola los datos guardados
    }

    // Restaurar progreso desde localStorage y descomprimir los datos
    function restoreProgressFromLocalStorage() {
        const savedData = localStorage.getItem('scanProgress');
        if (savedData) {
            // Descomprimir los datos antes de usarlos
            const decompressedData = LZString.decompress(savedData);
            const parsedData = JSON.parse(decompressedData);

            products = parsedData.products; // Restaurar productos
            scannedUnits = parsedData.scannedUnits; // Restaurar unidades escaneadas
            globalUnitsScanned = parsedData.globalUnitsScanned; // Restaurar contador global
            totalUnits = parsedData.totalUnits; // Restaurar total de unidades
            codigosCorrectos = parsedData.codigosCorrectos || []; // Restaurar códigos correctos
            codigosIncorrectos = parsedData.codigosIncorrectos || []; // Restaurar códigos incorrectos

            console.log("Datos descomprimidos y restaurados de localStorage:", parsedData); // Depuración

            // Actualizar la interfaz de usuario
            updateScannedList();
            updateGlobalCounter();
        } else {
            console.log("No se encontraron datos guardados en localStorage.");
        }
    }

    // Llamar a esta función al cargar la página
    restoreProgressFromLocalStorage();

    // Cargar archivo desde drive
    document.getElementById('cargar-desde-drive').addEventListener('click', () => {
        const fileId = document.getElementById('archivo-select').value;
        if (!fileId) {
            alert("Selecciona un cliente para cargar su archivo.");
            return;
        }

        const exportUrl = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=csv`;

        fetch(exportUrl)
            .then(response => {
                if (!response.ok) throw new Error("No se pudo acceder al archivo desde Drive.");
                return response.text();
            })
            .then(csvText => {
                Papa.parse(csvText, {
                    header: true,
                    skipEmptyLines: true,
                    complete: function (results) {
                        // Procesa aquí los datos como lo haces normalmente
                        products = results.data.map(item => ({
                            codigo_barra: item['codigo_barra'].trim(),
                            cantidad: parseInt(item['cantidad'].trim()),
                            ciudad: item['ciudad'].trim(),
                            codigos_validos: [
                                item['codigo_barra'].trim(),
                                ...(item['codigos_adicionales'] ? item['codigos_adicionales'].split(',').map(code => code.trim()) : [])
                            ].filter(code => code.length > 0),
                            scannedSubcodes: [],
                            noSufijoCount: 0
                        }));

                        scannedUnits = {};
                        globalUnitsScanned = 0;
                        totalUnits = products.reduce((acc, product) => acc + product.cantidad, 0);
                        products.forEach(product => {
                            scannedUnits[product.codigo_barra] = 0;
                        });

                        updateScannedList();
                        updateGlobalCounter();
                        saveProgressToLocalStorage();

                        document.getElementById('archivo-select').disabled = true;
                        document.getElementById('cargar-desde-drive').disabled = true;
                        // Mostrar cliente cargado con estilo
                        const selectedOption = document.getElementById('archivo-select').selectedOptions[0];
                        const contenedorCliente = document.getElementById('cliente-cargado');
                        contenedorCliente.innerText = `📦 Cliente cargado: ${selectedOption.text}`;
                        contenedorCliente.style.display = 'block';



                        alert("Archivo cargado correctamente.");
                    }
                });
            })
            .catch(error => {
                alert("Error al cargar el archivo: " + error.message);
            });
    });

    // Mostrar la cámara y el cuadro de enfoque dinámico
    document.getElementById('btn-abrir-camara').addEventListener('click', function () {
        initializeAudioContext();
        const scannerContainer = document.getElementById('scanner-container');
        const mainContent = document.getElementById('main-content');

        scannerContainer.style.display = 'block';
        mainContent.style.display = 'none';

        try {
            // Inicializar el objeto Html5Qrcode
            html5QrCode = new Html5Qrcode("scanner-video");

            const config = {
                fps: 10, // Reducir el FPS para minimizar repeticiones
                qrbox: { width: 250, height: 250 },
                disableFlip: true
            };

            html5QrCode.start(
                { facingMode: "environment" },
                config,
                (decodedText) => {
                    if (!scanLock) {
                        handleBarcodeScan(decodedText);

                        scanLock = true;
                        setTimeout(() => { scanLock = false; }, 3000);
                    }
                },
                (errorMessage) => console.log(`Error de escaneo: ${errorMessage}`)
            ).then(() => {
                console.log("Cámara iniciada correctamente.");
            }).catch((err) => {
                console.error("Error al iniciar la cámara:", err);
                alert("Error al iniciar la cámara. Asegúrate de permitir el acceso.");
            });
        } catch (e) {
            console.error("Error al crear Html5Qrcode:", e);
        }
    });

    // Detener la cámara y ocultar el cuadro de enfoque dinámico
    document.getElementById('close-scanner').addEventListener('click', function () {
        const scannerContainer = document.getElementById('scanner-container');
        const mainContent = document.getElementById('main-content');

        if (html5QrCode) {
            html5QrCode.stop().then(() => {
                scannerContainer.style.display = 'none';
                mainContent.style.display = 'block';
            }).catch(err => console.error("Error al detener la cámara:", err));
        }
    });


    // Manejar el evento de entrada en el campo de código de barras
    document.getElementById('barcodeInput').addEventListener('input', (event) => {
        const barcodeValue = document.getElementById('barcodeInput').value.trim();

        // Limpiar el temporizador anterior si el usuario sigue escribiendo
        clearTimeout(barcodeTimeout);

        // Si el campo no está vacío, esperar 1 segundo y luego simular el "Enter"
        if (barcodeValue !== '') {
            barcodeTimeout = setTimeout(() => {
                handleBarcodeScan(barcodeValue); // Llamar a la función que procesa el escaneo
                clearBarcodeInput(); // Limpiar el campo de entrada
            }, 1000); // Esperar 1 segundo
        }
    });

    // Función para limpiar el campo de código de barras (reutilizada)
    function clearBarcodeInput() {
        document.getElementById('barcodeInput').value = '';
    }
    // Función para formatear la hora en formato de 12 horas con AM/PM y segundos
    function obtenerHoraFormateada() {
        const ahora = new Date();
        let horas = ahora.getHours();
        let minutos = ahora.getMinutes();
        let segundos = ahora.getSeconds();
        const ampm = horas >= 12 ? 'PM' : 'AM';

        horas = horas % 12;
        horas = horas ? horas : 12; // El "0" se convierte en "12"
        minutos = minutos < 10 ? '0' + minutos : minutos; // Añadir un 0 delante si los minutos son menores a 10
        segundos = segundos < 10 ? '0' + segundos : segundos; // Añadir un 0 delante si los segundos son menores a 10

        const horaFormateada = horas + ':' + minutos + ':' + segundos + ' ' + ampm;
        return horaFormateada;
    }


    // Función para manejar el escaneo de códigos
    function handleBarcodeScan(scannedCode) {
        const parts = scannedCode.split('-');
        let sanitizedCode = parts[0].trim(); // Parte principal del código
        // Eliminar todos los ceros iniciales
        sanitizedCode = sanitizedCode.replace(/^0+/, '');

        const subCode = parts[1] || ''; // Obtener el subcódigo si existe
        const currentTime = obtenerHoraFormateada(); // Obtener la hora formateada en 12 horas AM/PM

        const product = products.find(p => p.codigos_validos.includes(sanitizedCode));

        if (product) {
            const currentScanned = scannedUnits[product.codigo_barra] || 0;
            if (currentScanned >= product.cantidad) {
                alert(`El producto ${sanitizedCode} ya ha alcanzado la cantidad total (${product.cantidad}) de unidades escaneadas.`);
                playTone(220, 500, 'square');
                clearBarcodeInput();
                return;
            }
            // Guardar el código y la hora como correcto solo si no ha sido agregado antes            
            codigosCorrectos.push({
                codigo: sanitizedCode,
                hora: currentTime // Almacenar la hora de escaneo
            });

            // Validación con subcódigos
            if (subCode === '' || product.cantidad === 1) {
                if (product.noSufijoCount < product.cantidad) {
                    product.noSufijoCount += 1;
                    scannedUnits[product.codigo_barra] += 1;
                    globalUnitsScanned += 1;
                    playTone(440, 200, 'sine'); // Tono de éxito
                } else {
                    alert(`El código ${sanitizedCode} ya ha sido escaneado todas las veces requeridas (${product.cantidad}).`);
                    playTone(220, 500, 'square');
                }
            } else {
                if (!product.scannedSubcodes.includes(subCode)) {
                    product.scannedSubcodes.push(subCode);
                    scannedUnits[product.codigo_barra] += 1;
                    globalUnitsScanned += 1;
                    playTone(440, 200, 'sine');
                } else {
                    alert(`El subcódigo -${subCode} de ${sanitizedCode} ya ha sido escaneado.`);
                    playTone(220, 500, 'square');
                }
            }
            updateScannedList(product.codigo_barra);
            updateGlobalCounter();
            // Guardar el progreso después de escanear o ingresar un código
            saveProgressToLocalStorage();
        } else {
            playTone(220, 500, 'square');
            alert("El código escaneado no coincide con ningún producto.");
            // Guardar el código y la hora como incorrecto solo si no ha sido agregado antes

            codigosIncorrectos.push({
                codigo: sanitizedCode,
                hora: currentTime // Almacenar la hora de escaneo
            });
        }
        clearBarcodeInput();
    }
    // Mostrar modal para finalizar la descarga
    document.getElementById('finalizar-descarga').addEventListener('click', () => {
        const modal = document.getElementById('modal');
        modal.style.display = 'flex';
        document.getElementById('fecha').value = new Date().toLocaleDateString();
    });

    // Cerrar el modal de información de la descarga
    document.getElementById('cerrar-modal').addEventListener('click', () => {
        document.getElementById('modal').style.display = 'none';
    });

    document.getElementById('terminar-proceso').addEventListener('click', function () {
        // Mostrar confirmación antes de continuar
        const confirmacion = confirm("¿Estás seguro de que deseas finalizar el proceso? Esto eliminará todos los datos escaneados.");

        if (confirmacion) {
            // Si el usuario confirma, eliminar los datos
            localStorage.removeItem('scanProgress'); // Limpiar localStorage

            // Vaciar los arrays de códigos correctos e incorrectos
            products = [];
            scannedUnits = {};
            globalUnitsScanned = 0;
            totalUnits = 0;
            codigosCorrectos = [];
            codigosIncorrectos = [];

            // Reactivar y limpiar selector
            const selector = document.getElementById('archivo-select');
            selector.disabled = false;
            selector.value = "";
            document.getElementById('cargar-desde-drive').disabled = false;

            // 🧹 Limpiar nombre del cliente cargado en pantalla
            const contenedorCliente = document.getElementById('cliente-cargado');
            contenedorCliente.innerText = '';
            contenedorCliente.style.display = 'none';


            // Actualizar la interfaz de usuario
            updateScannedList();
            updateGlobalCounter();

            // Guardar el estado limpio
            saveProgressToLocalStorage();

            alert('Proceso finalizado. Los datos se han eliminado.');
        } else {
            console.log('El usuario canceló la finalización del proceso.');
        }
    });

    // Mostrar resultado temporalmente (verde para éxito, rojo para error)
    function showTemporaryResult(isSuccess) {
        const scanResultContainer = document.getElementById('scan-result');
        const resultIcon = document.getElementById('result-icon');

        if (isSuccess) {
            resultIcon.innerHTML = '&#10004;'; // Checkmark (✓)
            scanResultContainer.style.backgroundColor = 'rgba(0, 255, 0, 0.8)'; // Fondo verde
        } else {
            resultIcon.innerHTML = '&#10006;'; // Crossmark (✖)
            scanResultContainer.style.backgroundColor = 'rgba(255, 0, 0, 0.8)'; // Fondo rojo
        }

        // Mostrar el resultado temporalmente
        scanResultContainer.classList.add('show-result');
        setTimeout(() => {
            scanResultContainer.classList.remove('show-result');
        }, 2000); // Mostrar durante 3 segundos
    }

    // Funciones de visualización de lista y progreso
    function updateScannedList(scannedCode = '') {
        const scannedList = document.getElementById('scanned-list');
        scannedList.innerHTML = '';

        const sortedProducts = products.slice().sort((a, b) => {
            if (a.codigo_barra === scannedCode) return -1;
            if (b.codigo_barra === scannedCode) return 1;
            return 0;
        });

        sortedProducts.forEach(product => {
            const totalScanned = scannedUnits[product.codigo_barra] || 0;
            const progressWidth = (totalScanned / product.cantidad) * 100;
            let statusClass = '';

            if (totalScanned === product.cantidad) {
                statusClass = 'status-complete';
            } else if (totalScanned > 0) {
                statusClass = 'status-warning';
            } else {
                statusClass = 'status-incomplete';
            }

            const additionalCodes = product.codigos_validos.join(', ');

            const li = document.createElement('li');
            li.className = statusClass;
            li.innerHTML = `
                
                <span><strong>Códigos Adicionales:</strong> ${additionalCodes}</span><br>                
                <span class="city"><strong>Ciudad:</strong> ${product.ciudad}</span>
                <div class="progress-bar">
                    <div class="progress-bar-inner" style="width: ${progressWidth}%"></div>
                </div>
                <span class="progress-text">${totalScanned} de ${product.cantidad} unidades escaneadas</span>
            `;
            scannedList.appendChild(li);
        });
    }

    // Actualizar el contador global
    function updateGlobalCounter() {
        const globalCounter = document.getElementById('global-counter');
        globalCounter.innerText = `Unidades descargadas: ${globalUnitsScanned} de ${totalUnits}`;
    }

    // Generar reporte en Excel con sufijos escaneados y faltantes solo si faltan
    document.getElementById('generar-reporte').addEventListener('click', () => {
        const placa = document.getElementById('placa').value;
        const remitente = document.getElementById('remitente').value.trim();
        const fecha = document.getElementById('fecha').value;

        if (!placa || !remitente) {
            alert("Por favor, completa todos los campos.");
            return;
        }

        const reportData = [
            ['Placa de Vehículo', placa],
            ['Remitente', remitente],
            ['Fecha de Descargue', fecha],
            [],
            ['Código de Barra', 'Unidades Escaneadas (Escaneadas/Total)', 'Ciudad', 'Sufijos Escaneados', 'Sufijos Faltantes']
        ];
        // Agregar la información de los productos escaneados
        products.forEach(product => {
            const unidadesEscaneadas = scannedUnits[product.codigo_barra] || 0;
            const sufijosFaltantes = getMissingSubcodes(product);

            reportData.push([
                product.codigo_barra,
                `${unidadesEscaneadas} / ${product.cantidad}`, // Mostrar el formato "X / Y"
                product.ciudad,
                product.scannedSubcodes.length > 0 ? product.scannedSubcodes.join(', ') : 'Ninguno',
                sufijosFaltantes.length > 0 ? sufijosFaltantes.join(', ') : '' // Mostrar solo si faltan
            ]);
        });
        // Agregar los códigos correctos al reporte
        reportData.push([], ['Códigos Correctos', 'Hora de Escaneo']);
        codigosCorrectos.forEach((item, index) => {
            reportData.push([index + 1, item.codigo, item.hora]);
        });


        // Agregar los códigos incorrectos al reporte
        reportData.push([], ['Códigos Incorrectos', 'Hora de Escaneo']);
        codigosIncorrectos.forEach((item, index) => {
            reportData.push([index + 1, item.codigo, item.hora]);
        });

        const ws = XLSX.utils.aoa_to_sheet(reportData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Reporte Descargue');
        // Guardar el archivo con el nombre del remitente y la fecha
        const fileName = `reporte_${remitente}_${new Date().toISOString().slice(0, 10)}.xlsx`;
        XLSX.writeFile(wb, fileName);

        alert('Reporte generado correctamente.');
        document.getElementById('modal').style.display = 'none';
    });

    // Obtener subcódigos faltantes para un producto dado
    function getMissingSubcodes(product) {
        if (scannedUnits[product.codigo_barra] === product.cantidad) {
            return []; // Si el número de unidades escaneadas coincide con la cantidad total, no hay faltantes
        }
        const expectedSubcodes = Array.from({ length: product.cantidad }, (_, i) => (i + 1).toString());
        return expectedSubcodes.filter(subCode => !product.scannedSubcodes.includes(subCode));
    }

});
