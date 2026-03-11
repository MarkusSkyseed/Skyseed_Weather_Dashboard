const weatherForm = document.getElementById('weather-form');
const btnLocate = document.getElementById('btn-locate');
const fileImport = document.getElementById('file-import');
const dashboard = document.getElementById('dashboard');
const loading = document.getElementById('loading');
const errorMessage = document.getElementById('error-message');
const locationNameEl = document.getElementById('location-name');

// Map Setup
let map;
let marker;
let polygonLayer; // To display imported areas
let stationsLayer; // Layer group for weather stations
let isPickerActive = false;

// Global Chart Instances to destroy before re-rendering
let mainChartInst = null;
let precipMonthlyChartInst = null;
let tempMonthlyChartInst = null;
let currentChartData = null; 
let allSourcesData = { 'open-meteo': null, 'dwd': null };
let fixedScales = null; // Store chart scales based on Open-Meteo
let lastBaseLocationName = ""; 

// Initialization: Set default dates (last 30 days)
document.addEventListener('DOMContentLoaded', () => {
    // Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./service-worker.js')
                .then(registration => console.log('ServiceWorker registered with scope:', registration.scope))
                .catch(error => console.log('ServiceWorker registration failed:', error));
        });
    }

    const today = new Date();
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(today.getDate() - 30);

    document.getElementById('end-date').value = today.toISOString().split('T')[0];
    document.getElementById('start-date').value = thirtyDaysAgo.toISOString().split('T')[0];

    // Setup Season Buttons
    const currentYear = today.getFullYear();
    const prevYear = currentYear - 1;
    
    const btnSeasonPrev = document.getElementById('btn-season-prev');
    const btnSeasonCurr = document.getElementById('btn-season-curr');
    
    btnSeasonPrev.innerText = `Saison ${prevYear}`;
    btnSeasonCurr.innerText = `Saison ${currentYear}`;
    
    btnSeasonPrev.addEventListener('click', () => {
        document.getElementById('start-date').value = `${prevYear}-01-01`;
        document.getElementById('end-date').value = `${prevYear}-12-31`;
    });
    
    btnSeasonCurr.addEventListener('click', () => {
        const today = new Date();
        const twoDaysAgo = new Date();
        twoDaysAgo.setDate(today.getDate() - 2); // Open-Meteo Archive has ~2 days delay
        
        document.getElementById('start-date').value = `${currentYear}-01-01`;
        document.getElementById('end-date').value = twoDaysAgo.toISOString().split('T')[0];
    });

    // Initialize map
    initMap();
    
    // Bind checkbox events for chart
    const checkboxes = document.querySelectorAll('.checkbox-group input[type="checkbox"]');
    checkboxes.forEach(cb => {
        cb.addEventListener('change', updateChartVisibility);
    });

    // Bind file import event
    fileImport.addEventListener('change', handleFileImport);

    // Bind station toggle
    document.getElementById('toggle-stations').addEventListener('change', toggleWeatherStations);

    // Bind Zoom Sliders
    document.getElementById('zoom-slider-start').addEventListener('input', updateChartZoom);
    document.getElementById('zoom-slider-end').addEventListener('input', updateChartZoom);
    document.getElementById('btn-reset-zoom').addEventListener('click', resetChartZoom);
    document.getElementById('btn-export-csv').addEventListener('click', exportToCSV);

    // Bind Source Switcher (Live Update)
    const sourceRadios = document.querySelectorAll('input[name="weather-source"]');
    sourceRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (allSourcesData[e.target.value]) {
                renderDashboard(allSourcesData[e.target.value]);
                updateStationInHeader(e.target.value);
            }
        });
    });
});

function initMap() {
    // Default center (e.g., Berlin)
    map = L.map('map').setView([52.52, 13.40], 5);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    // Add Scale
    L.control.scale({ imperial: false, metric: true }).addTo(map);

    // Add Measurement Tool
    const measureControl = new L.Control.Measure({
        primaryLengthUnit: 'meters',
        secondaryLengthUnit: 'kilometers',
        primaryAreaUnit: 'sqmeters',
        secondaryAreaUnit: 'hectares',
        activeColor: '#2c7a7b',
        completedColor: '#319795',
        localization: 'de',
        popupOptions: {
            autoPan: false,
            closeButton: false
        }
    });
    measureControl.addTo(map);

    stationsLayer = L.layerGroup().addTo(map);

    // Add Custom Location Picker Button
    const PickerControl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd: function() {
            const btn = L.DomUtil.create('a', 'location-picker-btn leaflet-bar');
            btn.innerHTML = '📍';
            btn.href = '#';
            btn.title = 'Standort für Wetterdaten festlegen';
            
            L.DomEvent.on(btn, 'click', function(e) {
                L.DomEvent.stopPropagation(e);
                L.DomEvent.preventDefault(e);
                togglePickerMode(btn);
            });
            return btn;
        }
    });
    map.addControl(new PickerControl());

    map.on('click', function(e) {
        if (isPickerActive) {
            const lat = e.latlng.lat.toFixed(6);
            const lon = e.latlng.lng.toFixed(6);
            clearPolygon();
            setCoordinates(lat, lon);
            togglePickerMode(document.querySelector('.location-picker-btn'));
        }
    });
}

function togglePickerMode(btn) {
    isPickerActive = !isPickerActive;
    if (isPickerActive) {
        btn.classList.add('active');
        map.getContainer().style.cursor = 'crosshair';
    } else {
        btn.classList.remove('active');
        map.getContainer().style.cursor = '';
    }
}

function clearPolygon() {
    if (polygonLayer) {
        map.removeLayer(polygonLayer);
        polygonLayer = null;
    }
}

function setCoordinates(lat, lon) {
    document.getElementById('coordinates').value = `${lat}, ${lon}`;
    
    if (marker) {
        marker.setLatLng([lat, lon]);
    } else {
        marker = L.marker([lat, lon]).addTo(map);
    }
    map.setView([lat, lon], 13);

    // Auto-update weather stations if enabled
    if (document.getElementById('toggle-stations').checked) {
        toggleWeatherStations({ target: { checked: true } });
    }
}

// File Import Logic
async function toggleWeatherStations(e) {
    if (e.target.checked) {
        showLoading();
        try {
            await fetchWeatherStations();
        } catch (err) {
            showError("Wetterstationen konnten nicht geladen werden: " + err.message);
            e.target.checked = false;
        } finally {
            hideLoading();
        }
    } else {
        stationsLayer.clearLayers();
    }
}

// --- Helper: Haversine Distance ---
function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Earth radius in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

async function fetchWeatherStations() {
    // Clear existing stations first
    stationsLayer.clearLayers();

    const coordsStr = document.getElementById('coordinates').value;
    if (!coordsStr) {
        throw new Error("Bitte zuerst einen Standort auf der Karte wählen.");
    }
    const [targetLat, targetLon] = coordsStr.split(',').map(s => parseFloat(s.trim()));

    // Official DWD CDC Station List
    const dwdUrl = 'https://opendata.dwd.de/climate_environment/CDC/help/KL_Tageswerte_Beschreibung_Stationen.txt';
    
    // Try multiple proxies to ensure reliability
    const proxies = [
        `https://corsproxy.io/?${encodeURIComponent(dwdUrl)}`,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(dwdUrl)}`,
        `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(dwdUrl)}`
    ];

    let text = "";
    
    for (const proxyUrl of proxies) {
        try {
            const response = await fetch(proxyUrl);
            if (response.ok) {
                // DWD files are typically ISO-8859-1 (Latin-1)
                const buffer = await response.arrayBuffer();
                const decoder = new TextDecoder('windows-1252'); // Handle German Umlaute
                text = decoder.decode(buffer);
                if (text && text.length > 500) break; // Success
            }
        } catch (e) {
            console.warn(`Proxy ${proxyUrl} failed:`, e);
            continue;
        }
    }

    if (!text) {
        throw new Error("DWD Stationsliste konnte nicht geladen werden.");
    }
    
    const lines = text.split('\n');
    
    // The file has a header (2 lines)
    // Format: Stations_id von_datum bis_datum Stationshoehe geoBreite geoLaenge Stationsname Bundesland
    const stations = [];
    const activeCutoff = 20250101;

    for (let i = 2; i < lines.length; i++) {
        const line = lines[i];
        if (line.length < 100) continue;

        const id = line.substring(0, 5).trim();
        const untilDate = line.substring(15, 23).trim();
        
        if (untilDate && parseInt(untilDate) < activeCutoff) continue;

        const lat = parseFloat(line.substring(39, 50).trim());
        const lon = parseFloat(line.substring(51, 60).trim());
        const elev = parseInt(line.substring(24, 38).trim());
        
        // Clean name and state (handle 'Frei' and Umlaute)
        let name = line.substring(61, 101).trim();
        let state = line.substring(102).trim().replace(/\s+Frei$/i, "");

        const dist = haversineDistance(targetLat, targetLon, lat, lon);

        if (dist <= 25) {
            stations.push({
                type: "Feature",
                properties: { id, name, elev, state, dist: dist.toFixed(2) },
                geometry: { type: "Point", coordinates: [lon, lat] }
            });
        }
    }

    if (stations.length === 0) {
        return; 
    }

    const data = { type: "FeatureCollection", features: stations };
    
    L.geoJSON(data, {
        pointToLayer: (feature, latlng) => {
            return L.circleMarker(latlng, {
                radius: 7,
                fillColor: "#e53e3e", 
                color: "#fff",
                weight: 2,
                opacity: 1,
                fillOpacity: 0.9
            });
        },
        onEachFeature: (feature, layer) => {
            const props = feature.properties;
            layer.bindPopup(`
                <div style="min-width: 200px">
                    <strong style="font-size: 1.1em">${props.name}</strong><br>
                    <span style="color: #666">Station ID: ${props.id}</span><br>
                    <hr style="margin: 5px 0; border: 0; border-top: 1px solid #eee">
                    <b>📍 Entfernung:</b> ${props.dist} km<br>
                    <b>⛰️ Höhe:</b> ${props.elev}m<br>
                    <b>🗺️ Bundesland:</b> ${props.state}<br>
                    <hr style="margin: 5px 0; border: 0; border-top: 1px solid #eee">
                    <small><b>Sensoren (Standard DWD CDC):</b><br>
                    Temp (2m), Feuchte, Niederschlag, Wind, Luftdruck, Globalstrahlung</small>
                </div>
            `);
        }
    }).addTo(stationsLayer);
}

async function handleFileImport(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
        const content = e.target.result;
        let points = [];

        try {
            if (file.name.endsWith('.kml')) {
                points = parseKML(content);
            } else if (file.name.endsWith('.plan')) {
                points = parsePlan(content);
            }

            if (points.length > 0) {
                displayPolygon(points);
                const centroid = calculateCentroid(points);
                setCoordinates(centroid.lat.toFixed(6), centroid.lon.toFixed(6));
                hideError();
            } else {
                showError("Keine gültigen Polygone in der Datei gefunden.");
            }
        } catch (err) {
            showError("Fehler beim Verarbeiten der Datei: " + err.message);
        }
    };
    reader.readAsText(file);
}

function parseKML(text) {
    const parser = new DOMParser();
    const kml = parser.parseFromString(text, "text/xml");
    const coordStrings = kml.getElementsByTagName("coordinates");
    let points = [];

    for (let coordStr of coordStrings) {
        const coords = coordStr.textContent.trim().split(/\s+/);
        for (let c of coords) {
            const parts = c.split(",");
            if (parts.length >= 2) {
                // KML is Lon, Lat, Alt
                points.push([parseFloat(parts[1]), parseFloat(parts[0])]);
            }
        }
    }
    return points;
}

function parsePlan(text) {
    const data = JSON.parse(text);
    let points = [];

    // Check geoFence polygons
    if (data.geoFence && data.geoFence.polygons) {
        for (let polyObj of data.geoFence.polygons) {
            if (polyObj.polygon) {
                // .plan polygons are [lat, lon]
                points = polyObj.polygon.map(p => [p[0], p[1]]);
                break; // Just take the first polygon for simplicity
            }
        }
    }
    
    // Fallback to mission items if no geoFence
    if (points.length === 0 && data.mission && data.mission.items) {
        points = data.mission.items
            .filter(item => item.params && item.params[4] !== undefined && item.params[5] !== undefined)
            .map(item => [item.params[4], item.params[5]]);
    }

    return points;
}

function displayPolygon(points) {
    clearPolygon();
    polygonLayer = L.polygon(points, { color: 'var(--primary-color)', fillOpacity: 0.3 }).addTo(map);
    map.fitBounds(polygonLayer.getBounds());
}

function calculateCentroid(points) {
    let lat = 0, lon = 0;
    points.forEach(p => {
        lat += p[0];
        lon += p[1];
    });
    return {
        lat: lat / points.length,
        lon: lon / points.length
    };
}

async function fetchLocationName(lat, lon) {
    try {
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=10&addressdetails=1`;
        const response = await fetch(url);
        if (response.ok) {
            const data = await response.json();
            if (data && data.address) {
                const city = data.address.city || data.address.town || data.address.village || data.address.county || "Unbekannter Ort";
                lastBaseLocationName = city;
                updateStationInHeader(document.querySelector('input[name="weather-source"]:checked').value);
                return;
            }
        }
        lastBaseLocationName = `${lat}, ${lon}`;
        updateStationInHeader(document.querySelector('input[name="weather-source"]:checked').value);
    } catch (error) {
        console.error("Geocoding error:", error);
        lastBaseLocationName = `${lat}, ${lon}`;
        updateStationInHeader(document.querySelector('input[name="weather-source"]:checked').value);
    }
}

function updateStationInHeader(source) {
    const dwdLabel = document.getElementById('label-dwd');
    
    if (allSourcesData.dwd && allSourcesData.dwd.station_name) {
        dwdLabel.innerText = `DWD: ${allSourcesData.dwd.station_name}`;
        if (source === 'dwd') {
            locationNameEl.innerText = `Auswertung für: ${lastBaseLocationName} (DWD Station: ${allSourcesData.dwd.station_name})`;
        } else {
            locationNameEl.innerText = `Auswertung für: ${lastBaseLocationName}`;
        }
    } else {
        dwdLabel.innerText = "DWD / Station (Messung)";
        locationNameEl.innerText = `Auswertung für: ${lastBaseLocationName}`;
    }
}

// Geolocation Handling
btnLocate.addEventListener('click', () => {
    if (!navigator.geolocation) {
        showError("Geolocation wird von deinem Browser nicht unterstützt.");
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const latStr = position.coords.latitude.toFixed(4);
            const lonStr = position.coords.longitude.toFixed(4);
            setCoordinates(latStr, lonStr);
            hideError();
        },
        (error) => {
            showError("Fehler beim Abrufen des Standorts: " + error.message);
        }
    );
});

// Form Submission
weatherForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const coordStr = document.getElementById('coordinates').value.trim();
    const startDate = document.getElementById('start-date').value;
    const endDate = document.getElementById('end-date').value;

    if (!coordStr || !startDate || !endDate) {
        showError("Bitte alle Felder ausfüllen.");
        return;
    }

    // Parse coordinates (expects "lat, lon" or "lat lon")
    const coordParts = coordStr.split(/[\s,]+/);
    if (coordParts.length < 2) {
        showError("Ungültiges Format für Koordinaten. Bitte im Format 'Lat, Lon' eingeben (z.B. 52.0728, 12.5552).");
        return;
    }

    const lat = parseFloat(coordParts[0]);
    const lon = parseFloat(coordParts[1]);

    if (isNaN(lat) || isNaN(lon)) {
        showError("Ungültige Koordinatenwerte. Bitte Zahlen eingeben.");
        return;
    }

    if (new Date(startDate) > new Date(endDate)) {
        showError("Das Startdatum darf nicht nach dem Enddatum liegen.");
        return;
    }

    setCoordinates(lat, lon); // Update marker on map if manually entered
    fetchLocationName(lat, lon); // Fetch and display city name

    hideError();
    showLoading();
    dashboard.classList.add('hidden');

    try {
        // Fetch both sources in parallel
        const [omRaw, dwdRaw] = await Promise.allSettled([
            fetchWeatherData(lat, lon, startDate, endDate, 'open-meteo'),
            fetchWeatherData(lat, lon, startDate, endDate, 'dwd')
        ]);

        // Process and store both
        allSourcesData['open-meteo'] = omRaw.status === 'fulfilled' ? prepareChartData(omRaw.value) : null;
        allSourcesData['dwd'] = dwdRaw.status === 'fulfilled' ? prepareChartData(dwdRaw.value) : null;

        // Calculate global fixed scales based on the maxima of BOTH sources
        fixedScales = calculateGlobalScales();

        const currentSource = document.querySelector('input[name="weather-source"]:checked').value;
        const dataToRender = allSourcesData[currentSource];

        if (!dataToRender) {
            if (currentSource === 'dwd' && dwdRaw.reason) throw dwdRaw.reason;
            if (currentSource === 'open-meteo' && omRaw.reason) throw omRaw.reason;
            throw new Error("Keine Daten für die gewählte Quelle verfügbar.");
        }

        renderDashboard(dataToRender);
        updateStationInHeader(currentSource);
        dashboard.classList.remove('hidden');
        document.body.classList.add('has-data');
    } catch (error) {
        showError("Fehler beim Abrufen der Wetterdaten: " + error.message);
    } finally {
        hideLoading();
    }
});

async function fetchWeatherData(lat, lon, startDate, endDate, source) {
    if (source === 'dwd') {
        return fetchBrightSkyData(lat, lon, startDate, endDate);
    }

    // Open-Meteo Historical API Endpoint
    // Note: soil_temperature is only available in 'hourly' for the archive API
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&hourly=soil_temperature_0_to_7cm&timezone=auto`;
    
    const response = await fetch(url);
    if (!response.ok) {
        if (response.status === 400) {
            throw new Error("API Fehler: Wahrscheinlich liegt das Enddatum zu nah an der Gegenwart oder die Parameter sind ungültig. Die Historien-API hat ca. 2 Tage Verzögerung.");
        }
        throw new Error(`API Fehler (${response.status})`);
    }
    
    const rawData = await response.json();

    // Aggregate hourly soil temperature to daily max
    if (rawData.hourly && rawData.hourly.soil_temperature_0_to_7cm) {
        const hourlySoil = rawData.hourly.soil_temperature_0_to_7cm;
        const hourlyTime = rawData.hourly.time;
        const dailySoilMax = {};

        hourlyTime.forEach((t, i) => {
            const date = t.split('T')[0];
            const temp = hourlySoil[i];
            if (temp !== null) {
                if (!dailySoilMax[date] || temp > dailySoilMax[date]) {
                    dailySoilMax[date] = temp;
                }
            }
        });

        rawData.daily.soil_temperature_0_to_7cm_max = rawData.daily.time.map(date => dailySoilMax[date] ?? null);
    }

    return rawData;
}

async function fetchBrightSkyData(lat, lon, startDate, endDate) {
    // Bright Sky uses ISO 8601 strings. 
    // We fetch hourly and aggregate to daily to match Open-Meteo format.
    const url = `https://api.brightsky.dev/weather?lat=${lat}&lon=${lon}&date=${startDate}&last_date=${endDate}`;
    
    const response = await fetch(url);
    if (!response.ok) throw new Error("Fehler beim Abrufen der Bright Sky Daten (DWD Station).");
    
    const raw = await response.json();
    if (!raw.weather || raw.weather.length === 0) throw new Error("Keine DWD Messdaten für diesen Zeitraum gefunden.");

    let stationName = "Unbekannt";
    if (raw.sources && raw.sources.length > 0) {
        stationName = raw.sources[0].station_name || raw.sources[0].dwd_station_id;
    }

    // Aggregate hourly data to daily
    const dailyData = {
        station_name: stationName,
        daily: {
            time: [],
            temperature_2m_max: [],
            temperature_2m_min: [],
            precipitation_sum: [],
            soil_temperature_0_to_7cm_max: []
        }
    };

    const days = {};
    const dayList = [];
    raw.weather.forEach(h => {
        const day = h.timestamp.split('T')[0];
        if (!days[day]) {
            days[day] = { temps: [], precip: 0 };
            dayList.push(day);
        }
        if (h.temperature !== null) days[day].temps.push(h.temperature);
        if (h.precipitation !== null) days[day].precip += h.precipitation;
    });

    dayList.sort().forEach((day, index) => {
        const d = days[day];
        const tAvgToday = d.temps.length ? d.temps.reduce((a, b) => a + b, 0) / d.temps.length : null;
        
        dailyData.daily.time.push(day);
        dailyData.daily.temperature_2m_max.push(d.temps.length ? Math.max(...d.temps) : null);
        dailyData.daily.temperature_2m_min.push(d.temps.length ? Math.min(...d.temps) : null);
        dailyData.daily.precipitation_sum.push(parseFloat(d.precip.toFixed(1)));

        // Soil temperature approximation
        // Formula: 0.79 * T_avg_today + 0.17 * T_avg_7d + 0.17 * T_avg_14d
        if (tAvgToday !== null) {
            const getAvgForOffset = (daysBack) => {
                let sum = 0;
                let count = 0;
                for (let i = 1; i <= daysBack; i++) {
                    const lookupIdx = index - i;
                    const fallbackIdx = Math.max(0, lookupIdx); // Use oldest known day as fallback
                    const prevDay = dayList[fallbackIdx];
                    const prevTemps = days[prevDay].temps;
                    if (prevTemps.length) {
                        sum += (prevTemps.reduce((a, b) => a + b, 0) / prevTemps.length);
                        count++;
                    }
                }
                return count > 0 ? sum / count : tAvgToday;
            };

            const tAvg7d = getAvgForOffset(7);
            const tAvg14d = getAvgForOffset(14);
            const soilTemp = (0.79 * tAvgToday) + (0.17 * tAvg7d) + (0.17 * tAvg14d);
            dailyData.daily.soil_temperature_0_to_7cm_max.push(parseFloat(soilTemp.toFixed(1)));
        } else {
            dailyData.daily.soil_temperature_0_to_7cm_max.push(null);
        }
    });

    return dailyData;
}

function prepareChartData(data) {
    if (!data.daily || !data.daily.time || data.daily.time.length === 0) {
        return null;
    }

    const daily = data.daily;
    const times = daily.time;
    const tempMax = daily.temperature_2m_max;
    const tempMin = daily.temperature_2m_min;
    const precipSum = daily.precipitation_sum;
    const soilTempMax = daily.soil_temperature_0_to_7cm_max || new Array(times.length).fill(null);

    // --- Calculate KPIs ---
    const validTempMax = tempMax.filter(v => v !== null);
    const validTempMin = tempMin.filter(v => v !== null);
    const absMaxTemp = validTempMax.length ? Math.max(...validTempMax) : 0;
    const absMinTemp = validTempMin.length ? Math.min(...validTempMin) : 0;
    const totalPrecip = precipSum.reduce((acc, val) => acc + (val || 0), 0);
    const validPrecip = precipSum.filter(v => v !== null);
    const maxPrecipDay = validPrecip.length ? Math.max(...validPrecip) : 0;
    const frostDaysCount = tempMin.filter(t => t !== null && t < 0).length;

    let totalGDD = 0;
    let totalGDD5 = 0; // New: Basis 5°C for trees
    const gddData = [];
    const gdd5Data = [];
    const cumulativePrecipData = [];
    let currentCumulativePrecip = 0;

    for (let i = 0; i < times.length; i++) {
        const tMax = tempMax[i] !== null ? tempMax[i] : 0;
        const tMin = tempMin[i] !== null ? tempMin[i] : 0;
        const avgTemp = (tMax + tMin) / 2;
        
        // GDD 10
        let dailyGDD = avgTemp - 10;
        if (dailyGDD < 0) dailyGDD = 0;
        totalGDD += dailyGDD;
        gddData.push(parseFloat(totalGDD.toFixed(1)));

        // GDD 5
        let dailyGDD5 = avgTemp - 5;
        if (dailyGDD5 < 0) dailyGDD5 = 0;
        totalGDD5 += dailyGDD5;
        gdd5Data.push(parseFloat(totalGDD5.toFixed(1)));

        const precip = precipSum[i] !== null ? precipSum[i] : 0;
        currentCumulativePrecip += precip;
        cumulativePrecipData.push(parseFloat(currentCumulativePrecip.toFixed(1)));
    }

    // --- Monthly Aggregation ---
    const monthlyPrecipMap = {};
    const monthlyTempSumMap = {};
    times.forEach((dateStr, index) => {
        const precipVal = precipSum[index] || 0;
        const tMax = tempMax[index] !== null ? tempMax[index] : 0;
        const tMin = tempMin[index] !== null ? tempMin[index] : 0;
        const avgTemp = (tMax + tMin) / 2;
        const tempSumVal = avgTemp > 0 ? avgTemp : 0;
        const monthStr = dateStr.substring(0, 7);
        if (!monthlyPrecipMap[monthStr]) {
            monthlyPrecipMap[monthStr] = 0;
            monthlyTempSumMap[monthStr] = 0;
        }
        monthlyPrecipMap[monthStr] += precipVal;
        monthlyTempSumMap[monthStr] += tempSumVal;
    });

    return {
        station_name: data.station_name || null,
        times, tempMax, tempMin, precipSum, soilTempMax, cumulativePrecipData, gddData, gdd5Data,
        monthlyLabels: Object.keys(monthlyPrecipMap),
        monthlyPrecipData: Object.values(monthlyPrecipMap).map(v => parseFloat(v.toFixed(1))),
        monthlyTempSumData: Object.values(monthlyTempSumMap).map(v => parseFloat(v.toFixed(1))),
        kpis: {
            absMaxTemp, absMinTemp, totalPrecip, maxPrecipDay, frostDaysCount, totalGDD, totalGDD5
        }
    };
}

function calculateGlobalScales() {
    let maxT = -99, minT = 99, maxPD = 0, maxPC = 0, maxG = 0, maxMP = 10, maxMTS = 10;
    let found = false;

    Object.values(allSourcesData).forEach(data => {
        if (!data) return;
        found = true;
        maxT = Math.max(maxT, data.kpis.absMaxTemp, ...data.soilTempMax.filter(v => v !== null));
        minT = Math.min(minT, data.kpis.absMinTemp, ...data.soilTempMax.filter(v => v !== null));
        maxPD = Math.max(maxPD, data.kpis.maxPrecipDay);
        maxPC = Math.max(maxPC, data.kpis.totalPrecip);
        maxG = Math.max(maxG, data.kpis.totalGDD);
        maxMP = Math.max(maxMP, ...data.monthlyPrecipData);
        maxMTS = Math.max(maxMTS, ...data.monthlyTempSumData);
    });

    if (!found) return null;

    const pad = (val, factor = 1.1) => val > 0 ? val * factor : val * 0.9;
    const padMin = (val) => val < 0 ? val * 1.1 : val * 0.9;

    return {
        yTemp: { min: Math.floor(padMin(minT)), max: Math.ceil(pad(maxT)) },
        yPrecipDaily: { min: 0, max: Math.ceil(pad(maxPD)) },
        yPrecipCum: { min: 0, max: Math.ceil(pad(maxPC)) },
        yGdd: { min: 0, max: Math.ceil(pad(maxG)) },
        yMonthlyPrecip: { min: 0, max: Math.ceil(pad(maxMP)) },
        yMonthlyTempSum: { min: 0, max: Math.ceil(pad(maxMTS)) }
    };
}

function renderDashboard(data) {
    currentChartData = data;

    // Update UI KPIs
    document.getElementById('kpi-temp-max').innerText = `${data.kpis.absMaxTemp.toFixed(1)} °C`;
    document.getElementById('kpi-temp-min').innerText = `${data.kpis.absMinTemp.toFixed(1)} °C`;
    document.getElementById('kpi-precip-sum').innerText = `${data.kpis.totalPrecip.toFixed(1)} mm`;
    document.getElementById('kpi-gdd').innerText = `${data.kpis.totalGDD.toFixed(1)}`;
    document.getElementById('kpi-precip-max').innerText = `${data.kpis.maxPrecipDay.toFixed(1)} mm`;
    document.getElementById('kpi-frost-days').innerText = data.kpis.frostDaysCount;

    // Render Charts
    renderUnifiedChartReal(); // Initialize Chart instance
    renderUnifiedChart();     // Setup sliders and apply zoom
    renderMonthlyPrecipChart();
    renderMonthlyTempSumChart();
}

function processDataAndRender(data) {
    // Legacy function - now handled by prepareChartData + renderDashboard
    const prepared = prepareChartData(data);
    if (prepared) renderDashboard(prepared);
}

function updateChartVisibility() {
    if (!mainChartInst) return;
    
    mainChartInst.data.datasets.forEach(dataset => {
        const id = dataset.customId;
        const isChecked = document.getElementById(id).checked;
        dataset.hidden = !isChecked;
    });
    
    mainChartInst.update();
}

function renderUnifiedChart() {
    if (!currentChartData) return;
    
    // Set slider range based on data points
    const startSlider = document.getElementById('zoom-slider-start');
    const endSlider = document.getElementById('zoom-slider-end');
    const maxIdx = currentChartData.times.length - 1;
    
    startSlider.max = maxIdx;
    endSlider.max = maxIdx;
    
    // Default to full range if not already adjusted or if new data loaded
    if (startSlider.value === "0" && endSlider.value === "100") { // Initial defaults
        startSlider.value = 0;
        endSlider.value = maxIdx;
    }

    applyChartZoom();
}

function updateChartZoom(e) {
    const startSlider = document.getElementById('zoom-slider-start');
    const endSlider = document.getElementById('zoom-slider-end');
    let startVal = parseInt(startSlider.value);
    let endVal = parseInt(endSlider.value);

    // Prevent sliders from crossing each other
    if (e.target.id === 'zoom-slider-start') {
        if (startVal >= endVal) {
            startSlider.value = endVal - 1;
            if (startSlider.value < 0) startSlider.value = 0;
        }
    } else {
        if (endVal <= startVal) {
            endSlider.value = startVal + 1;
            if (endSlider.value > parseInt(endSlider.max)) endSlider.value = endSlider.max;
        }
    }

    applyChartZoom();
}

function resetChartZoom() {
    const startSlider = document.getElementById('zoom-slider-start');
    const endSlider = document.getElementById('zoom-slider-end');
    startSlider.value = 0;
    endSlider.value = currentChartData ? currentChartData.times.length - 1 : 100;
    applyChartZoom();
}

function applyChartZoom() {
    if (!currentChartData || !mainChartInst) return;

    const startIdx = parseInt(document.getElementById('zoom-slider-start').value);
    const endIdx = parseInt(document.getElementById('zoom-slider-end').value);
    
    // Slice data for main chart and calculations
    const sliceTimes = currentChartData.times.slice(startIdx, endIdx + 1);
    const sliceTempMax = currentChartData.tempMax.slice(startIdx, endIdx + 1);
    const sliceTempMin = currentChartData.tempMin.slice(startIdx, endIdx + 1);
    const slicePrecip = currentChartData.precipSum.slice(startIdx, endIdx + 1);
    const sliceSoilTemp = currentChartData.soilTempMax.slice(startIdx, endIdx + 1);

    // 1. Update Zoom Text Display
    const displayRange = `${sliceTimes[0]} bis ${sliceTimes[sliceTimes.length-1]}`;
    document.getElementById('zoom-period-display').innerText = displayRange;

    // 2. Update Main Chart (without re-rendering everything)
    mainChartInst.data.labels = sliceTimes;
    mainChartInst.data.datasets[0].data = sliceTempMax;
    mainChartInst.data.datasets[1].data = sliceTempMin;
    mainChartInst.data.datasets[2].data = slicePrecip;
    // We keep the cumulative lines as they are (progression from period start)
    mainChartInst.data.datasets[3].data = currentChartData.cumulativePrecipData.slice(startIdx, endIdx + 1);
    mainChartInst.data.datasets[4].data = currentChartData.gddData.slice(startIdx, endIdx + 1);
    mainChartInst.data.datasets[5].data = sliceSoilTemp;
    mainChartInst.update('none');

    // 3. Recalculate KPIs for the visible range
    const validTMax = sliceTempMax.filter(v => v !== null);
    const validTMin = sliceTempMin.filter(v => v !== null);
    const absMax = validTMax.length ? Math.max(...validTMax) : 0;
    const absMin = validTMin.length ? Math.min(...validTMin) : 0;
    const totalP = slicePrecip.reduce((acc, val) => acc + (val || 0), 0);
    const maxP = slicePrecip.length ? Math.max(...slicePrecip.map(v => v || 0)) : 0;
    const frost = sliceTempMin.filter(v => v !== null && v < 0).length;
    
    // Calculate GDD specifically for this window
    let windowGDD = 0;
    for (let i = 0; i < sliceTimes.length; i++) {
        const avg = ((sliceTempMax[i] || 0) + (sliceTempMin[i] || 0)) / 2;
        windowGDD += Math.max(0, avg - 10);
    }

    // Update KPI Tiles
    document.getElementById('kpi-temp-max').innerText = `${absMax.toFixed(1)} °C`;
    document.getElementById('kpi-temp-min').innerText = `${absMin.toFixed(1)} °C`;
    document.getElementById('kpi-precip-sum').innerText = `${totalP.toFixed(1)} mm`;
    document.getElementById('kpi-gdd').innerText = `${windowGDD.toFixed(1)}`;
    document.getElementById('kpi-precip-max').innerText = `${maxP.toFixed(1)} mm`;
    document.getElementById('kpi-frost-days').innerText = frost;

    // 4. Update Tree Evaluation
    evaluateTreeGrowth(startIdx, endIdx);

    // 5. Update Secondary (Monthly) Charts
    updateMonthlyChartsForRange(sliceTimes, sliceTempMax, sliceTempMin, slicePrecip);
}

function evaluateTreeGrowth(startIdx, endIdx) {
    if (!currentChartData) return;

    const data = currentChartData;
    const allTimes = data.times.slice(startIdx, endIdx + 1);
    
    // Group indices by season
    const seasons = {
        'Frühjahr': { months: [3, 4, 5], indices: [], score: 'green', reason: 'Stabil' },
        'Sommer':   { months: [6, 7, 8], indices: [], score: 'green', reason: 'Stabil' },
        'Herbst':   { months: [9, 10, 11], indices: [], score: 'green', reason: 'Stabil' },
        'Winter':   { months: [12, 1, 2], indices: [], score: 'green', reason: 'Stabil' }
    };

    allTimes.forEach((t, i) => {
        const m = parseInt(t.split('-')[1]);
        const actualIdx = startIdx + i;
        for (const sName in seasons) {
            if (seasons[sName].months.includes(m)) {
                seasons[sName].indices.push(actualIdx);
            }
        }
    });

    const clusters = [
        { 
            id: 'tree-pioneer', 
            name: 'Frühstarter', 
            rootThreshold: 4, 
            budGDD5: 150, 
            heatLimit: 29, 
            precipLimitMonth: 60,
            winterHardy: true, 
            desc: 'Lärche, Birke, Eberesche' 
        },
        { 
            id: 'tree-flexible', 
            name: 'Flexible Nadelbäume', 
            rootThreshold: 6, 
            budGDD5: 300, 
            heatLimit: 35, 
            precipLimitMonth: 40,
            winterHardy: false, 
            desc: 'Kiefer, Douglasie' 
        },
        { 
            id: 'tree-cautious', 
            name: 'Die Vorsichtigen', 
            rootThreshold: 8, 
            budGDD5: 450, 
            heatLimit: 26, 
            precipLimitMonth: 70,
            winterHardy: true, 
            desc: 'Buche, Weißtanne' 
        },
        { 
            id: 'tree-warmth', 
            name: 'Wärmeliebende', 
            rootThreshold: 11, 
            budGDD5: 650, 
            heatLimit: 36, 
            precipLimitMonth: 50,
            winterHardy: false, 
            desc: 'Eiche, Esskastanie' 
        }
    ];

    let overallInsights = [];

    clusters.forEach(c => {
        const card = document.getElementById(c.id);
        const container = card.querySelector('.seasonal-eval-container');
        container.innerHTML = ''; // Clear previous

        let worstScore = 'green';

        for (const sName in seasons) {
            const sIndices = seasons[sName].indices;
            if (sIndices.length === 0) continue;

            // Sliced data for this season
            const sTempMax = sIndices.map(idx => data.tempMax[idx]);
            const sTempMin = sIndices.map(idx => data.tempMin[idx]);
            const sSoilTemp = sIndices.map(idx => data.soilTempMax[idx]);
            const sPrecip = sIndices.map(idx => data.precipSum[idx]);
            const sTimes = sIndices.map(idx => data.times[idx]);

            const avgSoilTemp = sSoilTemp.filter(v => v !== null).reduce((a, b) => a + b, 0) / sSoilTemp.filter(v => v !== null).length || 0;
            const minAirTemp = Math.min(...sTempMin.filter(v => v !== null)) || 0;
            const totalPrecip = sPrecip.reduce((a, b) => a + (b || 0), 0);
            const gdd5AtStart = sIndices[0] > 0 ? data.gdd5Data[sIndices[0] - 1] : 0;
            const totalGDD5_Slice = data.gdd5Data[sIndices[sIndices.length - 1]] - gdd5AtStart;

            let sScore = 'green';
            let sReasons = [];
            let sDetails = [];

            const addWarning = (score, reason, detail) => {
                if (score === 'red') sScore = 'red';
                else if (score === 'yellow' && sScore !== 'red') sScore = 'yellow';
                if (reason) sReasons.push(reason);
                if (detail) sDetails.push(detail);
            };

            // SPRING
            if (sName === 'Frühjahr') {
                if (avgSoilTemp < c.rootThreshold) { 
                    const coldDays = sIndices.filter(idx => data.soilTempMax[idx] !== null && data.soilTempMax[idx] < c.rootThreshold);
                    const firstCold = data.times[coldDays[0]];
                    addWarning('yellow', 'Boden zu kalt für Wurzelstart.', `Ø Bodentemperatur: ${avgSoilTemp.toFixed(1)}°C. Unterschreitung ab ${firstCold}.`);
                }
                
                // Critical Early Heat (May/June focus)
                const isEstablishmentPhase = sTimes.some(t => t.includes('-05-') || t.includes('-06-'));
                const hotIndices = sIndices.filter(idx => data.tempMax[idx] > 28);
                if (isEstablishmentPhase && hotIndices.length > 5 && totalPrecip < 20) {
                    addWarning('red', 'Kritische Etablierungsphase!', `Hitze im Mai/Juni (${hotIndices.length} Tage > 28°C, z.B. ${data.times[hotIndices[0]]}) bei zu wenig Regen.`);
                }

                let frostDays = [];
                sIndices.forEach(idx => {
                    if (data.gdd5Data[idx] > c.budGDD5 && data.tempMin[idx] < -2) {
                        frostDays.push(`${data.times[idx]} (${data.tempMin[idx]}°C)`);
                    }
                });
                if (frostDays.length > 0) { 
                    addWarning('red', 'Spätfrost-Schäden!', `Frost nach Austrieb am: ${frostDays.join(', ')}`);
                }
                
                // Phänologische Schere
                if (data.gdd5Data[sIndices[sIndices.length-1]] > 50 && sTempMax.filter(t => t > 15).length >= 3 && avgSoilTemp < c.rootThreshold) {
                    const schereDay = sIndices.find(idx => data.tempMax[idx] > 15 && data.soilTempMax[idx] < c.rootThreshold);
                    addWarning('red', 'Phänologische Schere!', `Boden zu kalt (${avgSoilTemp.toFixed(1)}°C), während Luft > 15°C Transpiration anregt (z.B. ${data.times[schereDay]}).`);
                }
            }
            // SUMMER
            else if (sName === 'Sommer') {
                const maxHeatIdx = sIndices.reduce((maxI, currI) => (data.tempMax[currI] > data.tempMax[maxI] ? currI : maxI), sIndices[0]);
                const maxHeat = data.tempMax[maxHeatIdx];
                const hotIndices = sIndices.filter(idx => data.tempMax[idx] > c.heatLimit);
                
                // Drought calculation
                let maxDrySpell = 0;
                let currentDrySpell = 0;
                let drySpellEnd = "";
                sIndices.forEach((idx, i) => {
                    if (data.precipSum[idx] < 1.0) {
                        currentDrySpell++;
                    } else {
                        if (currentDrySpell > maxDrySpell) {
                            maxDrySpell = currentDrySpell;
                            drySpellEnd = data.times[idx];
                        }
                        currentDrySpell = 0;
                    }
                });
                if (currentDrySpell > maxDrySpell) {
                    maxDrySpell = currentDrySpell;
                    drySpellEnd = data.times[sIndices[sIndices.length-1]];
                }

                if (maxHeat > c.heatLimit + 3 || (hotIndices.length > 7 && totalPrecip < 30)) {
                    addWarning('red', 'Extremer Hitzestress!', `Hitze (${hotIndices.length} Tage > ${c.heatLimit}°C, Peak am ${data.times[maxHeatIdx]}: ${maxHeat.toFixed(1)}°C).`);
                } else if (maxHeat > c.heatLimit || maxDrySpell > 14) {
                    addWarning('yellow', 'Trockenstress-Risiko.', `${maxDrySpell} Tage ohne Regen (bis ${drySpellEnd}). Hitze-Limit (${c.heatLimit}°C) erreicht.`);
                }

                if (c.id === 'tree-cautious' && maxHeat > 28) {
                    addWarning('red', 'Sonnenbrand-Gefahr!', `Schattbaumart auf Freifläche bei > 28°C kritisch (Peak: ${data.times[maxHeatIdx]}).`);
                }
            }
            // AUTUMN
            else if (sName === 'Herbst') {
                if (avgSoilTemp < 5) { 
                    const coldDay = sTimes.find((t, i) => sSoilTemp[i] < 5);
                    addWarning('yellow', 'Wurzelwachstum verlangsamt.', `Boden unter 5°C ab ca. ${coldDay}.`);
                }
                const warmDays = [];
                sIndices.forEach(idx => {
                    const m = parseInt(data.times[idx].split('-')[1]);
                    if ((m === 10 || m === 11) && data.tempMax[idx] > 18) warmDays.push(`${data.times[idx]} (${data.tempMax[idx]}°C)`);
                });
                if (warmDays.length > 0 && !c.winterHardy) { 
                    addWarning('yellow', 'Verholzung verzögert.', `Risiko durch milde Tage: ${warmDays.join(', ')}.`);
                }
                const earlyFrostDays = [];
                sIndices.forEach(idx => {
                    const m = parseInt(data.times[idx].split('-')[1]);
                    if ((m === 9 || m === 10) && data.tempMin[idx] < -1) earlyFrostDays.push(`${data.times[idx]} (${data.tempMin[idx]}°C)`);
                });
                if (earlyFrostDays.length > 0 && (c.id === 'tree-warmth' || c.id === 'tree-flexible')) { 
                    addWarning('red', 'Frühfrost-Gefahr!', `Kritischer Frost am: ${earlyFrostDays.join(', ')}.`);
                }
            }
            // WINTER
            else if (sName === 'Winter') {
                if (minAirTemp < -15 && !c.winterHardy) { 
                    const coldIdx = sIndices.find(idx => data.tempMin[idx] < -15);
                    addWarning('red', 'Gefahr durch Extremfrost.', `Tiefstwert am ${data.times[coldIdx]}: ${data.tempMin[coldIdx].toFixed(1)}°C.`);
                }
                const chillingCount = sTempMin.filter(t => t > 0 && t < 7).length;
                if (c.id === 'tree-pioneer' && chillingCount < 10) {
                    addWarning('yellow', 'Chilling Defizit.', `Nur ${chillingCount} Kältestunden (0-7°C) im Winterzeitraum.`);
                }

                if (sReasons.length === 0) sReasons.push('Winterruhe.');
            }

            if (sReasons.length === 0) sReasons.push('Gute Bedingungen.');

            // Append row to container
            const row = document.createElement('div');
            row.className = 'seasonal-row';
            if (sDetails.length > 0) row.title = sDetails.join('\n---\n'); // Combined Tooltip
            row.innerHTML = `
                <span class="season-label">${sName}</span>
                <span class="status-dot ${sScore}"></span>
                <span class="season-info">${sReasons.join('\n')}</span>
            `;
            container.appendChild(row);

            // Track worst score for global card border (optional, but good for overview)
            if (sScore === 'red') worstScore = 'red';
            else if (sScore === 'yellow' && worstScore !== 'red') worstScore = 'yellow';

            if (sScore === 'red') overallInsights.push(`${c.name} (${sName}):\n${sReasons.join('\n')}`);
        }
    });

    const insightsEl = document.getElementById('tree-insights-text');
    if (overallInsights.length > 0) {
        insightsEl.innerHTML = `<ul>${overallInsights.map(i => `<li>${i}</li>`).join('')}</ul>`;
    } else {
        insightsEl.innerText = "Klimatische Bedingungen im gewählten Zeitraum sind stabil.";
    }
}

function updateMonthlyChartsForRange(times, tempMax, tempMin, precipSum) {
    const monthlyPrecipMap = {};
    const monthlyTempSumMap = {};
    
    times.forEach((dateStr, index) => {
        const monthStr = dateStr.substring(0, 7);
        if (!monthlyPrecipMap[monthStr]) {
            monthlyPrecipMap[monthStr] = 0;
            monthlyTempSumMap[monthStr] = 0;
        }
        
        const pVal = precipSum[index] || 0;
        const tMax = tempMax[index] !== null ? tempMax[index] : 0;
        const tMin = tempMin[index] !== null ? tempMin[index] : 0;
        const avgTemp = (tMax + tMin) / 2;
        
        monthlyPrecipMap[monthStr] += pVal;
        monthlyTempSumMap[monthStr] += (avgTemp > 0 ? avgTemp : 0);
    });

    const labels = Object.keys(monthlyPrecipMap);
    const precipData = Object.values(monthlyPrecipMap).map(v => parseFloat(v.toFixed(1)));
    const tempSumData = Object.values(monthlyTempSumMap).map(v => parseFloat(v.toFixed(1)));

    if (precipMonthlyChartInst) {
        precipMonthlyChartInst.data.labels = labels;
        precipMonthlyChartInst.data.datasets[0].data = precipData;
        precipMonthlyChartInst.update('none');
    }
    
    if (tempMonthlyChartInst) {
        tempMonthlyChartInst.data.labels = labels;
        tempMonthlyChartInst.data.datasets[0].data = tempSumData;
        tempMonthlyChartInst.update('none');
    }
}

function renderUnifiedChartReal() {
    const ctx = document.getElementById('mainChart').getContext('2d');
    if (mainChartInst) mainChartInst.destroy();

    const data = currentChartData;
    
    // Determine current zoom indices
    const startIdx = parseInt(document.getElementById('zoom-slider-start').value) || 0;
    const endIdx = parseInt(document.getElementById('zoom-slider-end').value) || (data.times.length - 1);

    const isDwd = document.querySelector('input[name="weather-source"]:checked').value === 'dwd';
    const soilLabel = isDwd ? 'Bodentemp. (approximiert)' : 'Bodentemp. (0-7cm)';

    // Initial labels and data should respect the current zoom sliders
    const labels = data.times.slice(startIdx, endIdx + 1);

    mainChartInst = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Max Temperatur (°C)',
                    data: data.tempMax.slice(startIdx, endIdx + 1),
                    borderColor: '#e53e3e',
                    backgroundColor: 'rgba(229, 62, 62, 0.1)',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.3,
                    yAxisID: 'yTemp',
                    customId: 'toggle-temp-max',
                    hidden: !document.getElementById('toggle-temp-max').checked
                },
                {
                    label: 'Min Temperatur (°C)',
                    data: data.tempMin.slice(startIdx, endIdx + 1),
                    borderColor: '#3182ce',
                    backgroundColor: 'rgba(49, 130, 206, 0.1)',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.3,
                    yAxisID: 'yTemp',
                    customId: 'toggle-temp-min',
                    hidden: !document.getElementById('toggle-temp-min').checked
                },
                {
                    type: 'bar',
                    label: 'Niederschlag (mm/Tag)',
                    data: data.precipSum.slice(startIdx, endIdx + 1),
                    backgroundColor: 'rgba(44, 122, 123, 0.6)',
                    borderColor: '#2c7a7b',
                    borderWidth: 1,
                    yAxisID: 'yPrecipDaily',
                    customId: 'toggle-precip-daily',
                    hidden: !document.getElementById('toggle-precip-daily').checked
                },
                {
                    label: 'Summe Niederschlag (mm)',
                    data: data.cumulativePrecipData.slice(startIdx, endIdx + 1),
                    borderColor: '#319795',
                    backgroundColor: 'rgba(49, 151, 149, 0.1)',
                    borderWidth: 2,
                    borderDash: [5, 5],
                    fill: true,
                    tension: 0.3,
                    yAxisID: 'yPrecipCum',
                    customId: 'toggle-precip-sum',
                    hidden: !document.getElementById('toggle-precip-sum').checked
                },
                {
                    label: 'GDD (kumuliert)',
                    data: data.gddData.slice(startIdx, endIdx + 1),
                    borderColor: '#dd6b20', // Orange
                    backgroundColor: 'rgba(221, 107, 32, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3,
                    yAxisID: 'yGdd',
                    customId: 'toggle-gdd',
                    hidden: !document.getElementById('toggle-gdd').checked
                },
                {
                    label: soilLabel,
                    data: data.soilTempMax.slice(startIdx, endIdx + 1),
                    borderColor: '#805ad5', // Purple
                    backgroundColor: 'rgba(128, 90, 213, 0.1)',
                    borderWidth: 2,
                    fill: false,
                    tension: 0.3,
                    yAxisID: 'yTemp',
                    customId: 'toggle-soil-temp',
                    hidden: !document.getElementById('toggle-soil-temp').checked
                }
            ]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                tooltip: {
                    mode: 'index',
                    intersect: false
                },
                legend: {
                    display: false // We use our own custom checkboxes
                }
            },
            scales: {
                x: {
                    title: { display: true, text: 'Datum' }
                },
                yTemp: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    title: { display: true, text: 'Temperatur (°C)' },
                    min: fixedScales?.yTemp?.min,
                    max: fixedScales?.yTemp?.max
                },
                yPrecipDaily: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    title: { display: true, text: 'Niederschlag / Tag (mm)' },
                    grid: { drawOnChartArea: false },
                    min: fixedScales?.yPrecipDaily?.min,
                    max: fixedScales?.yPrecipDaily?.max
                },
                yPrecipCum: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    title: { display: true, text: 'Summe Niederschlag (mm)' },
                    grid: { drawOnChartArea: false },
                    min: fixedScales?.yPrecipCum?.min,
                    max: fixedScales?.yPrecipCum?.max
                },
                yGdd: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    title: { display: true, text: 'GDD' },
                    grid: { drawOnChartArea: false },
                    min: fixedScales?.yGdd?.min,
                    max: fixedScales?.yGdd?.max
                }
            }
        }
    });
}

function exportToCSV() {
    if (!currentChartData || !mainChartInst) {
        showError("Keine Daten zum Exportieren vorhanden.");
        return;
    }

    const labels = mainChartInst.data.labels;
    const source = document.querySelector('input[name="weather-source"]:checked').value;
    const sourceLabel = source === 'dwd' ? `DWD_Station_${currentChartData.station_name || 'unknown'}` : 'OpenMeteo';
    
    // CSV Header
    let csvContent = "Datum;Max_Temperatur_C;Min_Temperatur_C;Niederschlag_mm;Summe_Niederschlag_mm;GDD_kumuliert;Bodentemperatur_C\n";

    // Data rows (using the currently zoomed/visible range from mainChartInst)
    for (let i = 0; i < labels.length; i++) {
        const row = [
            labels[i],
            mainChartInst.data.datasets[0].data[i] ?? "",
            mainChartInst.data.datasets[1].data[i] ?? "",
            mainChartInst.data.datasets[2].data[i] ?? "",
            mainChartInst.data.datasets[3].data[i] ?? "",
            mainChartInst.data.datasets[4].data[i] ?? "",
            mainChartInst.data.datasets[5].data[i] ?? ""
        ];
        csvContent += row.join(";") + "\n";
    }

    // Create download link
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const timestamp = new Date().toISOString().slice(0, 10);
    
    link.setAttribute("href", url);
    link.setAttribute("download", `Wetterdaten_${sourceLabel}_${timestamp}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// Utility Functions
function showError(msg) {
    errorMessage.innerText = msg;
    errorMessage.classList.remove('hidden');
}

function hideError() {
    errorMessage.classList.add('hidden');
    errorMessage.innerText = '';
}

function showLoading() {
    loading.classList.remove('hidden');
}

function hideLoading() {
    loading.classList.add('hidden');
}

function renderMonthlyPrecipChart() {
    if (!currentChartData) return;
    
    const ctx = document.getElementById('precipMonthlyChart').getContext('2d');
    if (precipMonthlyChartInst) precipMonthlyChartInst.destroy();

    const data = currentChartData;

    precipMonthlyChartInst = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.monthlyLabels,
            datasets: [{
                label: 'Niederschlag (mm)',
                data: data.monthlyPrecipData,
                backgroundColor: '#319795', // Teal
                borderRadius: 4
            }]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    title: { display: true, text: 'Monat' }
                },
                y: {
                    min: fixedScales?.yMonthlyPrecip?.min,
                    max: fixedScales?.yMonthlyPrecip?.max,
                    title: { display: true, text: 'Niederschlag (mm)' }
                }
            }
        }
    });
}

function renderMonthlyTempSumChart() {
    if (!currentChartData) return;
    
    const ctx = document.getElementById('tempMonthlyChart').getContext('2d');
    if (tempMonthlyChartInst) tempMonthlyChartInst.destroy();

    const data = currentChartData;

    tempMonthlyChartInst = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.monthlyLabels,
            datasets: [{
                label: 'Temperatursumme (°C > 0)',
                data: data.monthlyTempSumData,
                backgroundColor: '#dd6b20', // Orange
                borderRadius: 4
            }]
        },
        options: {
            animation: false,
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    title: { display: true, text: 'Monat' }
                },
                y: {
                    min: fixedScales?.yMonthlyTempSum?.min,
                    max: fixedScales?.yMonthlyTempSum?.max,
                    title: { display: true, text: 'Summe °C' }
                }
            }
        }
    });
}
