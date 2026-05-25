// Visualizer State
let trajectory = null;
let currentStep = 0;
let isPlaying = false;
let playInterval = null;
let selectedAgent = null;

// Viewport Zoom & Pan
const canvas = document.getElementById('gridCanvas');
const ctx = canvas.getContext('2d');
const container = document.getElementById('canvasContainer');

let scale = 1.0;
let offsetX = 0;
let offsetY = 0;
let isDragging = false;
let dragStart = { x: 0, y: 0 };
const CELL_SIZE = 40;

// UI Elements
const fileInput = document.getElementById('fileInput');
const stepSlider = document.getElementById('stepSlider');
const speedSlider = document.getElementById('speedSlider');
const lblCurrentStep = document.getElementById('lblCurrentStep');
const lblMaxStep = document.getElementById('lblMaxStep');

const btnPlay = document.getElementById('btnPlay');
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const btnReset = document.getElementById('btnReset');
const playIcon = document.getElementById('playIcon');
const pauseIcon = document.getElementById('pauseIcon');

const btnZoomIn = document.getElementById('btnZoomIn');
const btnZoomOut = document.getElementById('btnZoomOut');
const btnZoomReset = document.getElementById('btnZoomReset');

const agentSelect = document.getElementById('agentSelect');
const agentCard = document.getElementById('agentCard');
const agentTableBody = document.getElementById('agentTableBody');
const reservationsTableBody = document.getElementById('reservationsTableBody');
const chkShowAllReservations = document.getElementById('chkShowAllReservations');

// Badge elements
const badgeSize = document.getElementById('badgeSize');
const badgeAgents = document.getElementById('badgeAgents');
const badgeCities = document.getElementById('badgeCities');
const badgeSeed = document.getElementById('badgeSeed');
const badgeSuccess = document.getElementById('badgeSuccess');

// Agent Color Mapping
function getAgentColor(handle) {
    if (!trajectory) return '#ffffff';
    const numAgents = trajectory.metadata.num_agents;
    const hue = (handle * 360 / numAgents) % 360;
    return `hsl(${hue}, 85%, 60%)`;
}

function getAgentColorAlpha(handle, alpha) {
    if (!trajectory) return 'rgba(255,255,255,0.5)';
    const numAgents = trajectory.metadata.num_agents;
    const hue = (handle * 360 / numAgents) % 360;
    return `hsla(${hue}, 85%, 60%, ${alpha})`;
}

// Map Action Integers to text
const ACTIONS = {
    0: 'DO_NOTHING',
    1: 'MOVE_LEFT',
    2: 'MOVE_FORWARD',
    3: 'MOVE_RIGHT',
    4: 'STOP_MOVING'
};

const DIRECTIONS = {
    0: 'North (▲)',
    1: 'East (▶)',
    2: 'South (▼)',
    3: 'West (◀)'
};

// Tabs Event Listeners
document.getElementById('tabAgentsBtn').addEventListener('click', (e) => switchTab('tabAgents', e.target));
document.getElementById('tabReservationsBtn').addEventListener('click', (e) => switchTab('tabReservations', e.target));
document.getElementById('tabHelpBtn').addEventListener('click', (e) => switchTab('tabHelp', e.target));

function switchTab(tabId, targetBtn) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
    targetBtn.classList.add('active');
    document.getElementById(tabId).classList.add('active');
}

// 1. Data Loader
fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(event) {
        try {
            const data = JSON.parse(event.target.result);
            loadTrajectory(data);
        } catch (err) {
            alert('Failed to parse trajectory JSON: ' + err.message);
        }
    };
    reader.readAsText(file);
});

// Load default trajectory.json if available via fetch
window.addEventListener('DOMContentLoaded', () => {
    fetch('trajectory.json')
        .then(response => {
            if (response.ok) return response.json();
            throw new Error('Not found');
        })
        .then(data => loadTrajectory(data))
        .catch(() => {
            // Silence error: user can load file manually
        });
    resizeCanvas();
});

function loadTrajectory(data) {
    trajectory = data;
    currentStep = 0;
    selectedAgent = null;
    isPlaying = false;
    if (playInterval) clearInterval(playInterval);
    updatePlayIcon();
    
    // Metadata Badges
    badgeSize.textContent = `${data.metadata.width}x${data.metadata.height}`;
    badgeAgents.textContent = data.metadata.num_agents;
    badgeCities.textContent = data.metadata.num_cities;
    badgeSeed.textContent = data.metadata.seed;
    
    // Final Success Rate
    const lastStep = data.steps[data.steps.length - 1];
    const nAgents = data.metadata.num_agents;
    const nDone = lastStep.agents.filter(a => a.state === 'DONE').length;
    const succRate = nDone / nAgents;
    badgeSuccess.textContent = `${(succRate * 100).toFixed(0)}%`;
    
    // Controls Sliders
    stepSlider.max = data.steps.length - 1;
    stepSlider.value = 0;
    lblMaxStep.textContent = data.steps.length - 1;
    lblCurrentStep.textContent = 0;
    
    // Populate Agent Select
    agentSelect.innerHTML = '<option value="">-- Select an Agent --</option>';
    data.agents.forEach(a => {
        const option = document.createElement('option');
        option.value = a.handle;
        option.textContent = `Agent #${a.handle} (Target: ${a.target[0]}, ${a.target[1]})`;
        agentSelect.appendChild(option);
    });
    
    // Reset view bounds to center grid
    resetView();
    updateUI();
}

// 2. Zoom & Pan
function resetView() {
    if (!trajectory) return;
    const gridW = trajectory.metadata.width * CELL_SIZE;
    const gridH = trajectory.metadata.height * CELL_SIZE;
    const containerW = container.clientWidth;
    const containerH = container.clientHeight;
    
    scale = Math.min(containerW / gridW, containerH / gridH) * 0.95;
    scale = Math.max(0.1, Math.min(scale, 5.0)); // Clip bounds
    
    offsetX = (containerW - gridW * scale) / 2;
    offsetY = (containerH - gridH * scale) / 2;
    draw();
}

btnZoomReset.addEventListener('click', resetView);
btnZoomIn.addEventListener('click', () => { zoom(1.2); });
btnZoomOut.addEventListener('click', () => { zoom(1 / 1.2); });

function zoom(factor) {
    const cx = container.clientWidth / 2;
    const cy = container.clientHeight / 2;
    
    // Zoom around center of container
    const x = (cx - offsetX) / scale;
    const y = (cy - offsetY) / scale;
    
    scale = Math.max(0.1, Math.min(scale * factor, 5.0));
    offsetX = cx - x * scale;
    offsetY = cy - y * scale;
    draw();
}

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    
    const mouseX = e.clientX - canvas.getBoundingClientRect().left;
    const mouseY = e.clientY - canvas.getBoundingClientRect().top;
    
    const x = (mouseX - offsetX) / scale;
    const y = (mouseY - offsetY) / scale;
    
    scale = Math.max(0.1, Math.min(scale * factor, 5.0));
    offsetX = mouseX - x * scale;
    offsetY = mouseY - y * scale;
    draw();
});

// Canvas Pan Drag
canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) { // Left click
        isDragging = true;
        dragStart.x = e.clientX - offsetX;
        dragStart.y = e.clientY - offsetY;
    }
});

window.addEventListener('mousemove', (e) => {
    if (isDragging) {
        offsetX = e.clientX - dragStart.x;
        offsetY = e.clientY - dragStart.y;
        draw();
    }
});

window.addEventListener('mouseup', (e) => {
    if (e.button === 0) {
        isDragging = false;
    }
});

// Canvas Click Selection
canvas.addEventListener('click', (e) => {
    if (!trajectory || isDragging) return;
    
    // Check if dragging was minor (ignore drag as click)
    const rect = canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    
    // Convert click coordinates to cell coordinates
    const cellC = Math.floor((clickX - offsetX) / (scale * CELL_SIZE));
    const cellR = Math.floor((clickY - offsetY) / (scale * CELL_SIZE));
    
    if (cellR >= 0 && cellR < trajectory.metadata.height && cellC >= 0 && cellC < trajectory.metadata.width) {
        // Find if any agent is in this cell at current step
        const stepData = trajectory.steps[currentStep];
        const agentAtCell = stepData.agents.find(a => a.position && a.position[0] === cellR && a.position[1] === cellC);
        
        if (agentAtCell !== undefined) {
            selectAgent(agentAtCell.handle);
        }
    }
});

function resizeCanvas() {
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    draw();
}
window.addEventListener('resize', resizeCanvas);

// 3. Playback Loop
btnPlay.addEventListener('click', togglePlay);
btnPrev.addEventListener('click', stepBackward);
btnNext.addEventListener('click', stepForward);
btnReset.addEventListener('click', () => { goToStep(0); });
stepSlider.addEventListener('input', (e) => { goToStep(parseInt(e.target.value)); });

function togglePlay() {
    if (!trajectory) return;
    isPlaying = !isPlaying;
    updatePlayIcon();
    if (isPlaying) {
        playLoop();
    } else {
        if (playInterval) clearInterval(playInterval);
    }
}

function updatePlayIcon() {
    if (isPlaying) {
        playIcon.style.display = 'none';
        pauseIcon.style.display = 'block';
    } else {
        playIcon.style.display = 'block';
        pauseIcon.style.display = 'none';
    }
}

function playLoop() {
    if (playInterval) clearInterval(playInterval);
    const speed = parseInt(speedSlider.value); // 1 to 10
    const delay = 1100 - speed * 100; // Mapped to 100ms - 1000ms delay
    
    playInterval = setInterval(() => {
        if (currentStep < trajectory.steps.length - 1) {
            stepForward();
        } else {
            togglePlay(); // Pause at end
        }
    }, delay);
}

speedSlider.addEventListener('input', () => {
    if (isPlaying) playLoop(); // Restart interval with new speed
});

function stepForward() {
    if (!trajectory) return;
    if (currentStep < trajectory.steps.length - 1) {
        goToStep(currentStep + 1);
    }
}

function stepBackward() {
    if (!trajectory) return;
    if (currentStep > 0) {
        goToStep(currentStep - 1);
    }
}

function goToStep(step) {
    currentStep = step;
    stepSlider.value = step;
    lblCurrentStep.textContent = step;
    updateUI();
}

// 4. Interface Updates
agentSelect.addEventListener('change', (e) => {
    const handle = e.target.value === "" ? null : parseInt(e.target.value);
    selectAgent(handle);
});

chkShowAllReservations.addEventListener('change', () => {
    draw();
});

function selectAgent(handle) {
    selectedAgent = handle;
    agentSelect.value = handle === null ? "" : handle.toString();
    
    // Highlight table row
    document.querySelectorAll('#agentTable tr').forEach(row => {
        row.classList.remove('selected');
        if (handle !== null && row.dataset.handle === handle.toString()) {
            row.classList.add('selected');
            row.scrollIntoView({ block: 'nearest' });
        }
    });

    updateUI();
}

function updateUI() {
    if (!trajectory) return;
    
    const stepData = trajectory.steps[currentStep];
    
    // Selected Agent Card Info
    if (selectedAgent !== null) {
        const agentState = stepData.agents.find(a => a.handle === selectedAgent);
        const agentMeta = trajectory.agents.find(a => a.handle === selectedAgent);
        
        agentCard.style.display = 'block';
        document.getElementById('agentTitle').textContent = `Agent #${selectedAgent}`;
        document.getElementById('agentTitle').style.color = getAgentColor(selectedAgent);
        
        // Status Badge class
        const badge = document.getElementById('agentStateBadge');
        badge.textContent = agentState.state;
        badge.className = 'status-badge ' + agentState.state.toLowerCase();
        
        document.getElementById('agentPos').textContent = agentState.position ? `[${agentState.position[0]}, ${agentState.position[1]}]` : 'OFF-GRID';
        document.getElementById('agentTarget').textContent = `[${agentMeta.target[0]}, ${agentMeta.target[1]}]`;
        document.getElementById('agentPriority').textContent = agentState.priority_rank;
        document.getElementById('agentSlack').textContent = agentState.slack.toFixed(1);
        document.getElementById('agentMalfunction').textContent = agentState.malfunction > 0 ? `${agentState.malfunction} steps` : 'None';
        document.getElementById('agentAction').textContent = `${agentState.action} (${ACTIONS[agentState.action]})`;
        document.getElementById('agentRecAction').textContent = `${agentState.recommended_action} (${ACTIONS[agentState.recommended_action]})`;
        
        // Build Action Mask Visualizer
        const maskGrid = document.getElementById('actionMaskGrid');
        maskGrid.innerHTML = '';
        
        const mask = agentState.action_mask; // L, F, R, STOP, DO_NOTHING? Wait, the mask is: L=1, F=2, R=3, STOP=4, DO_NOTHING=0 in order of action integers
        // Wait, mask ordering in MyObservationBuilder is:
        // [0] DO_NOTHING, [1] MOVE_LEFT, [2] MOVE_FORWARD, [3] MOVE_RIGHT, [4] STOP_MOVING
        const actionLabels = ['DO_NOTHING', 'MOVE_LEFT', 'MOVE_FORWARD', 'MOVE_RIGHT', 'STOP_MOVING'];
        for (let i = 0; i < 5; i++) {
            const isAllowed = mask[i] > 0.5;
            const maskItem = document.createElement('div');
            maskItem.className = `mask-item ${isAllowed ? 'active' : ''}`;
            
            const nameSpan = document.createElement('span');
            nameSpan.className = 'action-name';
            nameSpan.textContent = actionLabels[i].replace('MOVE_', '').replace('STOP_MOVING', 'STOP').replace('DO_NOTHING', 'WAIT');
            
            const valSpan = document.createElement('span');
            valSpan.className = 'action-val';
            valSpan.textContent = isAllowed ? 'YES' : 'NO';
            
            maskItem.appendChild(nameSpan);
            maskItem.appendChild(valSpan);
            maskGrid.appendChild(maskItem);
        }
    } else {
        agentCard.style.display = 'none';
    }
    
    // Sort agents by priority rank at this step
    const sortedAgents = [...stepData.agents].sort((a, b) => a.priority_rank - b.priority_rank);
    
    // Populate Agent list Table
    agentTableBody.innerHTML = '';
    sortedAgents.forEach(a => {
        const row = document.createElement('tr');
        row.dataset.handle = a.handle;
        if (selectedAgent === a.handle) row.className = 'selected';
        
        row.addEventListener('click', () => {
            selectAgent(a.handle);
        });
        
        const tdId = document.createElement('td');
        tdId.textContent = `#${a.handle}`;
        tdId.style.fontWeight = 'bold';
        tdId.style.color = getAgentColor(a.handle);
        
        const tdState = document.createElement('td');
        tdState.textContent = a.state;
        
        const tdSlack = document.createElement('td');
        tdSlack.textContent = a.slack.toFixed(1);
        
        const tdRank = document.createElement('td');
        tdRank.textContent = a.priority_rank;
        
        row.appendChild(tdId);
        row.appendChild(tdState);
        row.appendChild(tdSlack);
        row.appendChild(tdRank);
        agentTableBody.appendChild(row);
    });
    
    // Populate Reservations Table for the current step (only display active/upcoming reservations)
    reservationsTableBody.innerHTML = '';
    // Sort reservations by time step, then agent handle
    const sortedReservations = [...stepData.reservations]
        .filter(r => r.t >= currentStep)
        .sort((a, b) => a.t - b.t || a.handle - b.handle);
        
    sortedReservations.forEach(r => {
        const row = document.createElement('tr');
        if (selectedAgent === r.handle) row.style.backgroundColor = getAgentColorAlpha(r.handle, 0.08);
        
        row.addEventListener('click', () => {
            selectAgent(r.handle);
        });
        
        const tdCell = document.createElement('td');
        tdCell.textContent = `(${r.r}, ${r.c})`;
        tdCell.className = 'font-mono';
        
        const tdTime = document.createElement('td');
        tdTime.textContent = `t+${r.t - currentStep}`;
        tdTime.className = 'font-mono';
        
        const tdAgent = document.createElement('td');
        tdAgent.textContent = `#${r.handle}`;
        tdAgent.style.color = getAgentColor(r.handle);
        tdAgent.style.fontWeight = 'bold';
        
        const tdDir = document.createElement('td');
        tdDir.textContent = r.direction !== null ? DIRECTIONS[r.direction].split(' ')[0] : '-';
        
        row.appendChild(tdCell);
        row.appendChild(tdTime);
        row.appendChild(tdAgent);
        row.appendChild(tdDir);
        reservationsTableBody.appendChild(row);
    });
    
    draw();
}

// 5. Canvas Drawing routines
function getEntryCoord(cx, cy, hSize, d_in) {
    if (d_in === 0) return { x: cx, y: cy + hSize };
    if (d_in === 1) return { x: cx - hSize, y: cy };
    if (d_in === 2) return { x: cx, y: cy - hSize };
    if (d_in === 3) return { x: cx + hSize, y: cy };
    return null;
}

function getExitCoord(cx, cy, hSize, d_out) {
    if (d_out === 0) return { x: cx, y: cy - hSize };
    if (d_out === 1) return { x: cx + hSize, y: cy };
    if (d_out === 2) return { x: cx, y: cy + hSize };
    if (d_out === 3) return { x: cx - hSize, y: cy };
    return null;
}

function draw() {
    if (!trajectory) {
        // Draw splash screen
        ctx.fillStyle = '#0f111a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.fillStyle = 'hsl(220, 15%, 45%)';
        ctx.font = '16px "Outfit"';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Please load a trajectory.json file to begin analysis', canvas.width / 2, canvas.height / 2);
        return;
    }
    
    const height = trajectory.metadata.height;
    const width = trajectory.metadata.width;
    const stepData = trajectory.steps[currentStep];
    
    // Clear canvas
    ctx.fillStyle = '#0a0c10';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    
    // 1. Draw grid cell backgrounds & rails
    const grid = trajectory.grid;
    for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
            const val = grid[r][c];
            const cx = c * CELL_SIZE + CELL_SIZE / 2;
            const cy = r * CELL_SIZE + CELL_SIZE / 2;
            const hSize = CELL_SIZE / 2;
            
            // Draw empty grid cell boundaries
            ctx.strokeStyle = 'rgba(255,255,255,0.015)';
            ctx.lineWidth = 1;
            ctx.strokeRect(c * CELL_SIZE, r * CELL_SIZE, CELL_SIZE, CELL_SIZE);
            
            if (val > 0) {
                // Background cell highlighting
                ctx.fillStyle = '#121620';
                ctx.fillRect(c * CELL_SIZE + 1, r * CELL_SIZE + 1, CELL_SIZE - 2, CELL_SIZE - 2);
                
                // Draw tracks
                ctx.strokeStyle = '#2d3345';
                ctx.lineWidth = 3;
                ctx.lineCap = 'round';
                
                let isSwitch = false;
                
                // Determine if this cell is a switch by counting directions
                for (let d_in = 0; d_in < 4; d_in++) {
                    let outCount = 0;
                    for (let d_out = 0; d_out < 4; d_out++) {
                        const bitIndex = 15 - (d_in * 4 + d_out);
                        if ((val >> bitIndex) & 1) outCount++;
                    }
                    if (outCount > 1) {
                        isSwitch = true;
                        break;
                    }
                }
                
                if (isSwitch) {
                    ctx.strokeStyle = 'hsl(205, 40%, 35%)'; // Highlight switch cells with light blue
                    ctx.fillStyle = 'rgba(0, 150, 255, 0.03)';
                    ctx.fillRect(c * CELL_SIZE + 1, r * CELL_SIZE + 1, CELL_SIZE - 2, CELL_SIZE - 2);
                }
                
                for (let d_in = 0; d_in < 4; d_in++) {
                    for (let d_out = 0; d_out < 4; d_out++) {
                        const bitIndex = 15 - (d_in * 4 + d_out);
                        if ((val >> bitIndex) & 1) {
                            const entry = getEntryCoord(cx, cy, hSize, d_in);
                            const exit = getExitCoord(cx, cy, hSize, d_out);
                            
                            ctx.beginPath();
                            ctx.moveTo(entry.x, entry.y);
                            
                            // If straight or opposite
                            if ((d_in + 2) % 4 === d_out) {
                                ctx.lineTo(exit.x, exit.y);
                            } else {
                                // Curve turning using center as control point
                                ctx.quadraticCurveTo(cx, cy, exit.x, exit.y);
                            }
                            ctx.stroke();
                        }
                    }
                }
            }
        }
    }
    
    // 2. Draw stations / targets
    trajectory.agents.forEach(a => {
        const tr = a.target[0];
        const tc = a.target[1];
        const cx = tc * CELL_SIZE + CELL_SIZE / 2;
        const cy = tr * CELL_SIZE + CELL_SIZE / 2;
        
        ctx.fillStyle = 'rgba(180, 80, 255, 0.15)';
        ctx.strokeStyle = 'hsl(280, 75%, 65%)';
        ctx.lineWidth = 2;
        
        ctx.beginPath();
        ctx.arc(cx, cy, CELL_SIZE * 0.35, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
        
        // Innermost dot
        ctx.fillStyle = 'hsl(280, 75%, 65%)';
        ctx.beginPath();
        ctx.arc(cx, cy, 3, 0, 2 * Math.PI);
        ctx.fill();
        
        // Target Station Flag Name
        ctx.fillStyle = 'hsl(280, 40%, 80%)';
        ctx.font = '9px "JetBrains Mono"';
        ctx.textAlign = 'center';
        ctx.fillText(`S${a.handle}`, cx, cy - CELL_SIZE * 0.45);
    });

    // 3. Draw All Reservations Overlay (if enabled)
    if (chkShowAllReservations.checked) {
        stepData.reservations.forEach(res => {
            // Show future reservations (up to 12 steps)
            const dt = res.t - currentStep;
            if (dt >= 0 && dt <= 12) {
                const cx = res.c * CELL_SIZE + CELL_SIZE / 2;
                const cy = res.r * CELL_SIZE + CELL_SIZE / 2;
                
                // Draw a colored highlight around the cell
                ctx.fillStyle = getAgentColorAlpha(res.handle, Math.max(0.04, 0.2 - dt * 0.015));
                ctx.fillRect(res.c * CELL_SIZE + 2, res.r * CELL_SIZE + 2, CELL_SIZE - 4, CELL_SIZE - 4);
                
                // Draw tiny reservation details
                ctx.fillStyle = getAgentColorAlpha(res.handle, Math.max(0.3, 0.8 - dt * 0.05));
                ctx.font = '8px "JetBrains Mono"';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(`#${res.handle} t+${dt}`, cx, cy);
            }
        });
    }

    // 4. Draw Selected Agent Trajectory and Future Reservations Path
    if (selectedAgent !== null) {
        const agentState = stepData.agents.find(a => a.handle === selectedAgent);
        const color = getAgentColor(selectedAgent);
        
        // Draw active route path by linking reservations chronologically
        const pathRes = stepData.reservations
            .filter(r => r.handle === selectedAgent && r.t >= currentStep)
            .sort((a, b) => a.t - b.t);
            
        if (pathRes.length > 1) {
            ctx.strokeStyle = color;
            ctx.lineWidth = 3;
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            
            const first = pathRes[0];
            ctx.moveTo(first.c * CELL_SIZE + CELL_SIZE / 2, first.r * CELL_SIZE + CELL_SIZE / 2);
            for (let i = 1; i < pathRes.length; i++) {
                ctx.lineTo(pathRes[i].c * CELL_SIZE + CELL_SIZE / 2, pathRes[i].r * CELL_SIZE + CELL_SIZE / 2);
            }
            ctx.stroke();
            ctx.setLineDash([]); // Reset
        }
        
        // Draw line to target station
        const agentMeta = trajectory.agents.find(a => a.handle === selectedAgent);
        const targetX = agentMeta.target[1] * CELL_SIZE + CELL_SIZE / 2;
        const targetY = agentMeta.target[0] * CELL_SIZE + CELL_SIZE / 2;
        
        if (agentState.position) {
            const startX = agentState.position[1] * CELL_SIZE + CELL_SIZE / 2;
            const startY = agentState.position[0] * CELL_SIZE + CELL_SIZE / 2;
            ctx.strokeStyle = getAgentColorAlpha(selectedAgent, 0.25);
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(startX, startY);
            ctx.lineTo(targetX, targetY);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }

    // 5. Draw Agents
    stepData.agents.forEach(a => {
        if (!a.position) return; // Off-grid (e.g. WAITING, DONE, READY_TO_DEPART)
        
        const cx = a.position[1] * CELL_SIZE + CELL_SIZE / 2;
        const cy = a.position[0] * CELL_SIZE + CELL_SIZE / 2;
        const color = getAgentColor(a.handle);
        
        const isSelected = selectedAgent === a.handle;
        
        // Draw priority rank bubble
        if (isSelected) {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(cx, cy, CELL_SIZE * 0.45, 0, 2 * Math.PI);
            ctx.fill();
            ctx.stroke();
        }
        
        // Draw malfunction status
        if (a.malfunction > 0) {
            ctx.strokeStyle = 'hsl(355, 85%, 55%)';
            ctx.lineWidth = 2;
            ctx.setLineDash([2, 2]);
            ctx.beginPath();
            ctx.arc(cx, cy, CELL_SIZE * 0.4, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.setLineDash([]);
            
            // Malfunction icon overlay
            ctx.fillStyle = 'hsl(355, 85%, 55%)';
            ctx.font = 'bold 8px "Outfit"';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('⚠', cx - CELL_SIZE * 0.35, cy - CELL_SIZE * 0.35);
        }

        // Draw Agent Body (Chevron for moving, Square for stopped)
        ctx.fillStyle = color;
        ctx.save();
        ctx.translate(cx, cy);
        
        const isStopped = a.state === 'STOPPED' || a.malfunction > 0;
        
        if (isStopped) {
            // Draw Stopped train (Square)
            ctx.fillRect(-6, -6, 12, 12);
        } else {
            // Draw chevron pointing in direction
            const rot = a.direction * Math.PI / 2; // Direction: 0=N, 1=E, 2=S, 3=W
            ctx.rotate(rot);
            
            ctx.beginPath();
            ctx.moveTo(0, -9);
            ctx.lineTo(8, 7);
            ctx.lineTo(0, 3);
            ctx.lineTo(-8, 7);
            ctx.closePath();
            ctx.fill();
        }
        ctx.restore();
        
        // Label Agent ID
        ctx.fillStyle = '#ffffff';
        ctx.font = isSelected ? 'bold 9.5px "Outfit"' : '8.5px "Outfit"';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(a.handle.toString(), cx, cy - 1);
    });

    // 6. Draw Selected Agent Observation Space Overlays
    if (selectedAgent !== null) {
        const agentState = stepData.agents.find(a => a.handle === selectedAgent);
        if (agentState.position) {
            const cx = agentState.position[1] * CELL_SIZE + CELL_SIZE / 2;
            const cy = agentState.position[0] * CELL_SIZE + CELL_SIZE / 2;
            const dir = agentState.direction;
            
            // Draw recommended action arrow (if moving and recommend not DO_NOTHING/STOP)
            const recAct = agentState.recommended_action;
            const actMask = agentState.action_mask;
            
            // Action mask visualization
            // Action Ordering in mask: 0=DO_NOTHING, 1=MOVE_LEFT, 2=MOVE_FORWARD, 3=MOVE_RIGHT, 4=STOP_MOVING
            const maskDirs = [null, (dir - 1 + 4) % 4, dir, (dir + 1) % 4, null];
            
            for (let i = 1; i <= 3; i++) {
                if (actMask[i] > 0.5) {
                    const arrowDir = maskDirs[i];
                    const targetCell = getExitCoord(cx, cy, CELL_SIZE * 0.45, arrowDir);
                    
                    // Draw mini green indicator line for legal moves
                    ctx.strokeStyle = '#4ade80';
                    ctx.lineWidth = 2.5;
                    ctx.beginPath();
                    ctx.moveTo(cx, cy);
                    ctx.lineTo(targetCell.x, targetCell.y);
                    ctx.stroke();
                }
            }
            
            // Highlight Recommended Action with thick glowing blue arrow
            if (recAct >= 1 && recAct <= 3 && actMask[recAct] > 0.5) {
                const recDir = maskDirs[recAct];
                const end = getExitCoord(cx, cy, CELL_SIZE * 0.8, recDir);
                
                ctx.strokeStyle = 'hsl(205, 90%, 55%)';
                ctx.lineWidth = 4;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                
                // Draw Arrow stem
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.lineTo(end.x, end.y);
                ctx.stroke();
                
                // Draw Arrow head
                ctx.fillStyle = 'hsl(205, 90%, 55%)';
                ctx.save();
                ctx.translate(end.x, end.y);
                ctx.rotate(recDir * Math.PI / 2);
                
                ctx.beginPath();
                ctx.moveTo(0, -6);
                ctx.lineTo(5, 4);
                ctx.lineTo(-5, 4);
                ctx.closePath();
                ctx.fill();
                ctx.restore();
            }
        }
    }
    
    ctx.restore();
}
