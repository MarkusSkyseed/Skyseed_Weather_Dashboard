const weatherForm = document.getElementById('weather-form');
const btnLocate = document.getElementById('btn-locate');
const dashboard = document.getElementById('dashboard');
const loading = document.getElementById('loading');
const errorMessage = document.getElementById('error-message');

// Global Chart Instances to destroy before re-rendering
let tempChartInst = null;
let precipDailyChartInst = null;
let precipMonthlyChartInst = null;

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
});

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
            document.getElementById('coordinates').value = `${latStr}, ${lonStr}`;
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

    hideError();
    showLoading();
    dashboard.classList.add('hidden');

    try {
        const data = await fetchWeatherData(lat, lon, startDate, endDate);
        processDataAndRender(data);
        dashboard.classList.remove('hidden');
    } catch (error) {
        showError("Fehler beim Abrufen der Wetterdaten: " + error.message);
    } finally {
        hideLoading();
    }
});

async function fetchWeatherData(lat, lon, startDate, endDate) {
    // Open-Meteo Historical API Endpoint
    // Required params: latitude, longitude, start_date, end_date, daily variables
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${startDate}&end_date=${endDate}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max&timezone=auto`;
    
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`API Fehler (${response.status})`);
    }
    
    const data = await response.json();
    return data;
}

function processDataAndRender(data) {
    if (!data.daily || !data.daily.time || data.daily.time.length === 0) {
        throw new Error("Keine Daten für diesen Zeitraum gefunden.");
    }

    const daily = data.daily;
    const times = daily.time;
    const tempMax = daily.temperature_2m_max;
    const tempMin = daily.temperature_2m_min;
    const precipSum = daily.precipitation_sum;
    const windMax = daily.wind_speed_10m_max;

    // --- Calculate KPIs ---
    
    // 1. Absolute Max & Min Temp
    // filter out nulls
    const validTempMax = tempMax.filter(v => v !== null);
    const validTempMin = tempMin.filter(v => v !== null);
    
    const absMaxTemp = validTempMax.length ? Math.max(...validTempMax) : 0;
    const absMinTemp = validTempMin.length ? Math.min(...validTempMin) : 0;

    // 2. Total Precipitation
    const totalPrecip = precipSum.reduce((acc, val) => acc + (val || 0), 0);

    // 3. Max Precip per day
    const validPrecip = precipSum.filter(v => v !== null);
    const maxPrecipDay = validPrecip.length ? Math.max(...validPrecip) : 0;

    // 4. Max Wind Speed
    const validWind = windMax.filter(v => v !== null);
    const maxWind = validWind.length ? Math.max(...validWind) : 0;

    // 5. Frost Days (Days where min temp < 0)
    const frostDaysCount = tempMin.filter(t => t !== null && t < 0).length;

    // Update UI KPIs
    document.getElementById('kpi-temp-max').innerText = `${absMaxTemp.toFixed(1)} °C`;
    document.getElementById('kpi-temp-min').innerText = `${absMinTemp.toFixed(1)} °C`;
    document.getElementById('kpi-precip-sum').innerText = `${totalPrecip.toFixed(1)} mm`;
    document.getElementById('kpi-precip-max').innerText = `${maxPrecipDay.toFixed(1)} mm`;
    document.getElementById('kpi-wind-max').innerText = `${maxWind.toFixed(1)} km/h`;
    document.getElementById('kpi-frost-days').innerText = frostDaysCount;


    // --- Monthly Precipitation Calculation ---
    const monthlyPrecipMap = {};
    
    times.forEach((dateStr, index) => {
        const val = precipSum[index] || 0;
        // Format YYYY-MM
        const monthStr = dateStr.substring(0, 7);
        if (!monthlyPrecipMap[monthStr]) {
            monthlyPrecipMap[monthStr] = 0;
        }
        monthlyPrecipMap[monthStr] += val;
    });

    const monthlyLabels = Object.keys(monthlyPrecipMap);
    const monthlyData = Object.values(monthlyPrecipMap).map(v => parseFloat(v.toFixed(1)));

    // --- Render Charts ---
    renderTempChart(times, tempMax, tempMin);
    renderPrecipDailyChart(times, precipSum);
    renderPrecipMonthlyChart(monthlyLabels, monthlyData);
}

function renderTempChart(labels, tempMaxData, tempMinData) {
    const ctx = document.getElementById('tempChart').getContext('2d');
    if (tempChartInst) tempChartInst.destroy();

    tempChartInst = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Max Temperatur (°C)',
                    data: tempMaxData,
                    borderColor: '#e53e3e',
                    backgroundColor: 'rgba(229, 62, 62, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3
                },
                {
                    label: 'Min Temperatur (°C)',
                    data: tempMinData,
                    borderColor: '#3182ce',
                    backgroundColor: 'rgba(49, 130, 206, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3
                }
            ]
        },
        options: {
            responsive: true,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                tooltip: {
                    mode: 'index',
                    intersect: false
                }
            },
            scales: {
                y: {
                    title: { display: true, text: 'Temperatur (°C)' }
                }
            }
        }
    });
}

function renderPrecipDailyChart(labels, data) {
    const ctx = document.getElementById('precipDailyChart').getContext('2d');
    if (precipDailyChartInst) precipDailyChartInst.destroy();

    precipDailyChartInst = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Niederschlag (mm)',
                data: data,
                backgroundColor: '#2c7a7b',
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Niederschlag (mm)' }
                }
            }
        }
    });
}

function renderPrecipMonthlyChart(labels, data) {
    const ctx = document.getElementById('precipMonthlyChart').getContext('2d');
    if (precipMonthlyChartInst) precipMonthlyChartInst.destroy();

    precipMonthlyChartInst = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Monatlicher Niederschlag (mm)',
                data: data,
                backgroundColor: '#319795',
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Niederschlag (mm)' }
                }
            }
        }
    });
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
