import { extension_settings, getContext, saveMetadataDebounced } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { MemoryMapManager } from './src/MemoryMapManager.js';

const EXTENSION_NAME = 'memory-map';
const EXTENSION_FOLDER = `scripts/extensions/third_party/${EXTENSION_NAME}`;

let isPopupOpen = false;
let memoryMapManager = null;

// ─── Default Settings ───────────────────────────────────────────────
const defaultSettings = {
    api_provider: 'openai',
    api_url: '',
    api_key: '',
    api_model: 'gpt-4o-mini',
    inject_style: 'casual',   // 'casual' = грубоватая коррекция, 'formal' = нейтральная
    auto_inject: true,         // автоматически инжектить коррекцию
    macro_enabled: true,       // обрабатывать {{memorymap}}
    debug: false,
};

// ─── Settings Init ──────────────────────────────────────────────────
function initSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = {};
    }
    for (const key in defaultSettings) {
        if (extension_settings[EXTENSION_NAME][key] === undefined) {
            extension_settings[EXTENSION_NAME][key] = defaultSettings[key];
        }
    }
}

// ─── HTML Loading ───────────────────────────────────────────────────
async function loadHtml() {
    try {
        const response = await fetch(`${EXTENSION_FOLDER}/index.html`);
        if (!response.ok) {
            // Fallback path for different ST directory structures
            const fallback = await fetch(`extensions/third_party/${EXTENSION_NAME}/index.html`);
            if (!fallback.ok) throw new Error('Could not load HTML from any known path');
            const html = await fallback.text();
            $('body').append(html);
        } else {
            const html = await response.text();
            $('body').append(html);
        }
        setupPopupEvents();
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Failed to load HTML:`, err);
    }
}

// ─── Popup Events ───────────────────────────────────────────────────
function setupPopupEvents() {
    // Tab switching
    $(document).on('click', '.memory-map-tab', function () {
        $('.memory-map-tab').removeClass('active');
        $(this).addClass('active');
        $('.mm-tab-pane').removeClass('active');
        const target = $(this).data('tab');
        $(`#${target}`).addClass('active');
    });

    // Close
    $(document).on('click', '#memory_map_close', () => togglePopup(false));

    // Anxiety slider label
    $(document).on('input', '#mm_char_anxiety', function () {
        $('#mm_char_anxiety_val').text(`${$(this).val()}%`);
    });

    // Auto-save on change (debounced for text inputs)
    let saveTimer = null;
    $(document).on('change', '#memory_map_popup select, #memory_map_popup input[type="checkbox"], #memory_map_popup input[type="range"]', () => {
        syncFromUI();
    });
    $(document).on('input', '#memory_map_popup input[type="text"], #memory_map_popup input[type="password"], #memory_map_popup textarea', () => {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => syncFromUI(), 500);
    });

    // Dragging
    let isDragging = false;
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    $(document).on('mousedown', '.memory-map-handle', function (e) {
        isDragging = true;
        const popup = document.getElementById('memory_map_popup');
        const rect = popup.getBoundingClientRect();
        dragOffsetX = e.clientX - rect.left;
        dragOffsetY = e.clientY - rect.top;
        // Remove centering transform on first drag
        popup.style.transform = 'none';
        e.preventDefault();
    });

    $(document).on('mousemove', function (e) {
        if (!isDragging) return;
        const popup = document.getElementById('memory_map_popup');
        popup.style.left = (e.clientX - dragOffsetX) + 'px';
        popup.style.top = (e.clientY - dragOffsetY) + 'px';
    });

    $(document).on('mouseup', () => { isDragging = false; });

    // Manual refresh button
    $(document).on('click', '#mm_refresh_btn', async () => {
        if (!memoryMapManager) return;
        $('#mm_refresh_btn').prop('disabled', true).text('Analyzing...');
        try {
            await memoryMapManager.forceAnalyze();
            loadStateToUI();
        } catch (err) {
            console.error(`[${EXTENSION_NAME}] Manual refresh failed:`, err);
        }
        $('#mm_refresh_btn').prop('disabled', false).text('Refresh Now');
    });

    // Reset data button
    $(document).on('click', '#mm_reset_btn', () => {
        if (!memoryMapManager) return;
        if (confirm('Reset all Memory Map data for this chat?')) {
            memoryMapManager.resetData();
            loadStateToUI();
        }
    });
}

// ─── Chatbar Button ─────────────────────────────────────────────────
function addChatbarButton() {
    const buttonHtml = `
        <div id="memory_map_toggle" class="list-group-item flex-container flexGap5 interactable" title="Memory Map">
            <i class="fas fa-brain"></i>
            <span>Memory Map</span>
        </div>
    `;

    // Try multiple known ST selectors for extension menu
    const targets = [
        '#extensionsMenu .list-group',
        '#extensions_settings',
        '#form_sheld .flex-container',
    ];

    let inserted = false;
    for (const selector of targets) {
        const $target = $(selector);
        if ($target.length) {
            $target.append(buttonHtml);
            inserted = true;
            break;
        }
    }

    // Fallback: add a floating button if no known container found
    if (!inserted) {
        const floatingBtn = `
            <div id="memory_map_toggle" class="mm-floating-button" title="Memory Map">
                <i class="fas fa-brain"></i>
            </div>
        `;
        $('body').append(floatingBtn);
        console.warn(`[${EXTENSION_NAME}] Could not find ST menu container, using floating button`);
    }

    $(document).on('click', '#memory_map_toggle', () => togglePopup());
}

// ─── Popup Toggle ───────────────────────────────────────────────────
function togglePopup(forceState = null) {
    isPopupOpen = forceState !== null ? forceState : !isPopupOpen;

    if (isPopupOpen) {
        $('#memory_map_popup').fadeIn(150);
        loadSettingsToUI();
        loadStateToUI();
    } else {
        $('#memory_map_popup').fadeOut(150);
    }
}

// ─── Settings <-> UI Sync ───────────────────────────────────────────
function loadSettingsToUI() {
    const s = extension_settings[EXTENSION_NAME];
    $('#mm_api_provider').val(s.api_provider || 'openai');
    $('#mm_api_url').val(s.api_url || '');
    $('#mm_api_key').val(s.api_key || '');
    $('#mm_api_model').val(s.api_model || '');
    $('#mm_api_debug').prop('checked', !!s.debug);
    $('#mm_inject_style').val(s.inject_style || 'casual');
    $('#mm_auto_inject').prop('checked', s.auto_inject !== false);
    $('#mm_macro_enabled').prop('checked', s.macro_enabled !== false);
}

function loadStateToUI() {
    if (!memoryMapManager) return;
    const d = memoryMapManager.getData();

    // Timeline tab
    $('#mm_state_time').val(d.timeline?.current_time || '');
    $('#mm_state_finances').val(d.timeline?.finances || '');
    $('#mm_state_holidays').val(d.timeline?.holidays || '');
    $('#mm_state_inventory').val(d.timeline?.inventory || '');

    // Character tab
    $('#mm_char_anxiety').val(d.character?.anxiety || 0);
    $('#mm_char_anxiety_val').text(`${d.character?.anxiety || 0}%`);
    $('#mm_char_health').val(d.character?.health || '');
    $('#mm_char_psych').val(d.character?.psych_eval || '');
    $('#mm_char_behavior').val(d.character?.restrictions || '');

    // NPCs tab
    $('#mm_npc_behavior').val(d.npcs?.behavior || '');
    $('#mm_npc_reactions').val(d.npcs?.reactions || '');

    // Memory tab
    $('#mm_mem_chain').val(d.memory?.event_chain || '');
    $('#mm_mem_summary').val(d.memory?.detailed_summary || '');
    $('#mm_mem_unreliable').val(d.memory?.unreliable_pov || '');

    // Corrections
    $('#mm_corrections').val(d.corrections || '');
}

function syncFromUI() {
    // Save API settings
    const s = extension_settings[EXTENSION_NAME];
    s.api_provider = $('#mm_api_provider').val();
    s.api_url = $('#mm_api_url').val();
    s.api_key = $('#mm_api_key').val();
    s.api_model = $('#mm_api_model').val();
    s.debug = $('#mm_api_debug').prop('checked');
    s.inject_style = $('#mm_inject_style').val();
    s.auto_inject = $('#mm_auto_inject').prop('checked');
    s.macro_enabled = $('#mm_macro_enabled').prop('checked');

    // Save state data if manager exists
    if (memoryMapManager) {
        memoryMapManager.updateData({
            timeline: {
                current_time: $('#mm_state_time').val(),
                finances: $('#mm_state_finances').val(),
                holidays: $('#mm_state_holidays').val(),
                inventory: $('#mm_state_inventory').val(),
            },
            character: {
                anxiety: parseInt($('#mm_char_anxiety').val()) || 0,
                health: $('#mm_char_health').val(),
                psych_eval: $('#mm_char_psych').val(),
                restrictions: $('#mm_char_behavior').val(),
            },
            npcs: {
                behavior: $('#mm_npc_behavior').val(),
                reactions: $('#mm_npc_reactions').val(),
            },
            memory: {
                event_chain: $('#mm_mem_chain').val(),
                detailed_summary: $('#mm_mem_summary').val(),
                unreliable_pov: $('#mm_mem_unreliable').val(),
            },
            corrections: $('#mm_corrections').val(),
        });
    }
}

// ─── Event Handlers ─────────────────────────────────────────────────
function onChatChanged() {
    if (memoryMapManager) {
        memoryMapManager.onChatChanged();
        if (isPopupOpen) loadStateToUI();
    }
}

async function onMessageReceived(msgId) {
    try {
        const context = getContext();
        if (!context.chat || context.chat.length === 0) return;

        const s = extension_settings[EXTENSION_NAME];
        if (!s.api_url || !s.api_key) {
            if (s.debug) console.log(`[${EXTENSION_NAME}] Skipping analysis: no API configured`);
            return;
        }

        // Gather last few messages for context
        const depth = 4;
        const startIdx = Math.max(0, context.chat.length - depth);
        let contextStr = '';
        for (let i = startIdx; i < context.chat.length; i++) {
            const msg = context.chat[i];
            const speaker = msg.is_user ? (context.name1 || 'User') : (context.name2 || 'Character');
            contextStr += `${speaker}: ${msg.mes}\n\n`;
        }

        if (memoryMapManager) {
            await memoryMapManager.analyzeMessage(contextStr);
            if (isPopupOpen) loadStateToUI();
        }
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Error processing message:`, err);
    }
}

// ─── Slash Commands & Hooks ─────────────────────────────────────────
function registerCommands() {
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'memorymap',
            callback: () => {
                return memoryMapManager ? memoryMapManager.getMacroSummary() : '[Memory Map: no data]';
            },
            returns: 'string',
            helpString: 'Returns the current Memory Map state summary for prompt injection.',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'memorymap-full',
            callback: () => {
                return memoryMapManager ? memoryMapManager.getFullReport() : '[Memory Map: no data]';
            },
            returns: 'string',
            helpString: 'Returns the full Memory Map analysis.',
        }));

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'memorymap-refresh',
            callback: async () => {
                if (memoryMapManager) await memoryMapManager.forceAnalyze();
                return 'Memory Map refreshed.';
            },
            returns: 'string',
            helpString: 'Force-refresh Memory Map analysis on the latest messages.',
        }));
    } catch (err) {
        console.warn(`[${EXTENSION_NAME}] Could not register slash commands:`, err);
    }
}

function registerHooks() {
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

    // Inject correction after AI generates a message
    eventSource.on(event_types.MESSAGE_SENT, async () => {
        try {
            const s = extension_settings[EXTENSION_NAME];
            if (!s.auto_inject || !memoryMapManager) return;
            const correction = memoryMapManager.getCorrectionPrompt(s.inject_style);
            if (correction) {
                if (s.debug) console.log(`[${EXTENSION_NAME}] Correction ready:`, correction);
                // The correction text is available; injection into context happens
                // via the macro or via extension_prompt system depending on ST version
            }
        } catch (err) {
            console.error(`[${EXTENSION_NAME}] Injection error:`, err);
        }
    });
}

// ─── Entry Point ────────────────────────────────────────────────────
jQuery(async () => {
    try {
        console.log(`[${EXTENSION_NAME}] Initializing...`);
        initSettings();
        memoryMapManager = new MemoryMapManager(EXTENSION_NAME);
        await loadHtml();
        addChatbarButton();
        registerCommands();
        registerHooks();
        onChatChanged();
        console.log(`[${EXTENSION_NAME}] Loaded successfully`);
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] FATAL: Failed to initialize:`, err);
    }
});
