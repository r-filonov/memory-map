import { extension_settings, getContext, saveMetadataDebounced } from '../../../../extensions.js';

/**
 * MemoryMapManager — ядро расширения.
 *
 * Отвечает за:
 * - хранение данных привязанно к текущему чату
 * - отправку сообщений на Extra API для анализа
 * - парсинг ответа и раскладку по категориям
 * - генерацию инжектов (макрос + коррекция)
 */

// ─── System Prompt для "второй ИИшки" ──────────────────────────────
const ANALYSIS_SYSTEM_PROMPT = `You are a precise scene analyzer for a roleplay tracking system. You receive the latest messages from an RP chat and must extract/update the following state. Return ONLY valid JSON, no markdown, no explanation.

Your analysis principles:
- REALISM: Track realistic health consequences (e.g. a professional figure skater WILL have RED-S symptoms; pregnancy complications for athletes are real)
- UNRELIABLE NARRATOR: Character memories are subjective, NOT objective truth. Note bias, denial, selective recall.
- NPC BEHAVIOR: NPCs should react realistically to character traits (attractiveness draws attention; rudeness has consequences)
- PSYCH EVAL: Characters should not be impossibly alpha or impossibly soft. Note inconsistencies.
- FINANCES: Track money flow realistically (salary schedule, expenses, taxes)
- TIME: Track in-scene time progression, note holidays/seasons

Return this exact JSON structure:
{
  "timeline": {
    "current_time": "in-scene date/time or approximate period",
    "finances": "financial status, pending payments, salary info",
    "holidays": "upcoming holidays or notable dates if relevant",
    "inventory": "what characters are wearing, carrying, notable items in scene"
  },
  "character": {
    "anxiety": 0-100,
    "health": "physical health notes with realistic consequences",
    "psych_eval": "psychological assessment, consistency check, alpha/softness balance",
    "restrictions": "behavioral constraints, things the character cannot/should not do given their state"
  },
  "npcs": {
    "behavior": "how NPCs are acting and why",
    "reactions": "realistic NPC reactions to character traits/actions"
  },
  "memory": {
    "event_chain": "event1 -> event2 -> event3 (short chain)",
    "detailed_summary": "detailed chronological summary of key events only",
    "unreliable_pov": "how the CHARACTER remembers things (biased, emotional, possibly wrong)"
  },
  "corrections": "list of realism violations or inconsistencies that need fixing, or empty string if none"
}

If you cannot determine a field from the available context, keep its previous value or use empty string. Never invent events that didn't happen.`;

export class MemoryMapManager {
    constructor(extensionName) {
        this.extensionName = extensionName;
        this.data = this._emptyData();
        this.chatId = null;
        this.isAnalyzing = false;
        console.log('[Memory Map] Manager initialized');
    }

    // ─── Data Structure ─────────────────────────────────────────────
    _emptyData() {
        return {
            timeline: {
                current_time: '',
                finances: '',
                holidays: '',
                inventory: '',
            },
            character: {
                anxiety: 0,
                health: '',
                psych_eval: '',
                restrictions: '',
            },
            npcs: {
                behavior: '',
                reactions: '',
            },
            memory: {
                event_chain: '',
                detailed_summary: '',
                unreliable_pov: '',
            },
            corrections: '',
            _last_analyzed: 0,
        };
    }

    // ─── Chat Data Persistence ──────────────────────────────────────
    _getStorageKey() {
        return `memorymap_${this.chatId}`;
    }

    onChatChanged() {
        try {
            const context = getContext();
            const newChatId = context.chatId || context.characters?.[context.characterId]?.chat;
            if (newChatId !== this.chatId) {
                this.chatId = newChatId;
                this._loadFromStorage();
            }
        } catch (err) {
            console.error('[Memory Map] Error on chat change:', err);
            this.data = this._emptyData();
        }
    }

    _loadFromStorage() {
        try {
            const context = getContext();
            const stored = context.chatMetadata?.[this._getStorageKey()];
            if (stored) {
                this.data = { ...this._emptyData(), ...JSON.parse(stored) };
                console.log('[Memory Map] Loaded data for chat:', this.chatId);
            } else {
                this.data = this._emptyData();
                console.log('[Memory Map] No saved data for chat:', this.chatId);
            }
        } catch (err) {
            console.error('[Memory Map] Failed to load data:', err);
            this.data = this._emptyData();
        }
    }

    _saveToStorage() {
        try {
            const context = getContext();
            if (!context.chatMetadata) return;
            context.chatMetadata[this._getStorageKey()] = JSON.stringify(this.data);
            saveMetadataDebounced();
        } catch (err) {
            console.error('[Memory Map] Failed to save data:', err);
        }
    }

    // ─── Public Getters / Setters ───────────────────────────────────
    getData() {
        return this.data;
    }

    updateData(partial) {
        this.data = this._deepMerge(this.data, partial);
        this._saveToStorage();
    }

    resetData() {
        this.data = this._emptyData();
        this._saveToStorage();
    }

    // ─── API Analysis ───────────────────────────────────────────────
    async analyzeMessage(contextStr) {
        if (this.isAnalyzing) return;

        const s = extension_settings[this.extensionName];
        if (!s.api_url || !s.api_key) return;

        this.isAnalyzing = true;
        try {
            const previousState = JSON.stringify(this.data, null, 2);
            const userPrompt = `Previous state:\n${previousState}\n\n---\nLatest messages:\n${contextStr}\n\nAnalyze and return updated JSON state.`;

            const result = await this._callAPI(s, userPrompt);
            if (result) {
                // Merge rather than replace so manual edits aren't lost
                this.data = this._deepMerge(this.data, result);
                this.data._last_analyzed = Date.now();
                this._saveToStorage();

                if (s.debug) console.log('[Memory Map] Analysis complete:', this.data);
            }
        } catch (err) {
            console.error('[Memory Map] Analysis failed:', err);
        } finally {
            this.isAnalyzing = false;
        }
    }

    async forceAnalyze() {
        const context = getContext();
        if (!context.chat || context.chat.length === 0) return;

        const depth = 6;
        const startIdx = Math.max(0, context.chat.length - depth);
        let contextStr = '';
        for (let i = startIdx; i < context.chat.length; i++) {
            const msg = context.chat[i];
            const speaker = msg.is_user ? (context.name1 || 'User') : (context.name2 || 'Character');
            contextStr += `${speaker}: ${msg.mes}\n\n`;
        }

        this.isAnalyzing = false; // force reset lock
        await this.analyzeMessage(contextStr);
    }

    async _callAPI(settings, userPrompt) {
        const { api_provider, api_url, api_key, api_model } = settings;

        let body, headers;

        if (api_provider === 'anthropic') {
            headers = {
                'Content-Type': 'application/json',
                'x-api-key': api_key,
                'anthropic-version': '2023-06-01',
            };
            body = {
                model: api_model || 'claude-sonnet-4-20250514',
                max_tokens: 2000,
                system: ANALYSIS_SYSTEM_PROMPT,
                messages: [{ role: 'user', content: userPrompt }],
            };
        } else {
            // OpenAI-compatible (default)
            headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${api_key}`,
            };
            body = {
                model: api_model || 'gpt-4o-mini',
                max_tokens: 2000,
                temperature: 0.3,
                messages: [
                    { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
                    { role: 'user', content: userPrompt },
                ],
            };
        }

        const response = await fetch(api_url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API ${response.status}: ${errText.substring(0, 200)}`);
        }

        const data = await response.json();
        let text = '';

        if (api_provider === 'anthropic') {
            text = data.content?.[0]?.text || '';
        } else {
            text = data.choices?.[0]?.message?.content || '';
        }

        // Strip markdown code fences if present
        text = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();

        try {
            return JSON.parse(text);
        } catch (err) {
            console.error('[Memory Map] Failed to parse API response as JSON:', text.substring(0, 300));
            return null;
        }
    }

    // ─── Prompt Generation ──────────────────────────────────────────

    /** Short summary for {{memorymap}} macro */
    getMacroSummary() {
        const d = this.data;
        const parts = [];

        if (d.timeline?.current_time) parts.push(`Time: ${d.timeline.current_time}`);
        if (d.timeline?.inventory) parts.push(`Wearing/Carrying: ${d.timeline.inventory}`);
        if (d.character?.health) parts.push(`Health: ${d.character.health}`);
        if (d.character?.anxiety > 0) parts.push(`Anxiety: ${d.character.anxiety}%`);
        if (d.memory?.event_chain) parts.push(`Recent: ${d.memory.event_chain}`);

        return parts.length > 0
            ? `[Memory Map]\n${parts.join('\n')}`
            : '[Memory Map: no data yet]';
    }

    /** Full report for /memorymap-full command */
    getFullReport() {
        const d = this.data;
        const sections = [];

        sections.push('=== MEMORY MAP FULL REPORT ===');

        if (d.timeline) {
            sections.push(`\n--- TIMELINE ---`);
            if (d.timeline.current_time) sections.push(`Time: ${d.timeline.current_time}`);
            if (d.timeline.inventory) sections.push(`Inventory/Clothing: ${d.timeline.inventory}`);
            if (d.timeline.finances) sections.push(`Finances: ${d.timeline.finances}`);
            if (d.timeline.holidays) sections.push(`Holidays: ${d.timeline.holidays}`);
        }

        if (d.character) {
            sections.push(`\n--- CHARACTER ---`);
            if (d.character.anxiety > 0) sections.push(`Anxiety/Publicity: ${d.character.anxiety}%`);
            if (d.character.health) sections.push(`Health: ${d.character.health}`);
            if (d.character.psych_eval) sections.push(`Psych: ${d.character.psych_eval}`);
            if (d.character.restrictions) sections.push(`Restrictions: ${d.character.restrictions}`);
        }

        if (d.npcs) {
            sections.push(`\n--- NPCs ---`);
            if (d.npcs.behavior) sections.push(`Behavior: ${d.npcs.behavior}`);
            if (d.npcs.reactions) sections.push(`Reactions: ${d.npcs.reactions}`);
        }

        if (d.memory) {
            sections.push(`\n--- MEMORY ---`);
            if (d.memory.event_chain) sections.push(`Chain: ${d.memory.event_chain}`);
            if (d.memory.detailed_summary) sections.push(`Summary: ${d.memory.detailed_summary}`);
            if (d.memory.unreliable_pov) sections.push(`Character POV: ${d.memory.unreliable_pov}`);
        }

        if (d.corrections) {
            sections.push(`\n--- CORRECTIONS NEEDED ---`);
            sections.push(d.corrections);
        }

        return sections.join('\n');
    }

    /** Correction prompt injected as user message */
    getCorrectionPrompt(style = 'casual') {
        const d = this.data;
        if (!d.corrections && !d.character?.health && !d.npcs?.reactions) return '';

        const parts = [];

        if (style === 'casual') {
            // Грубоватая коррекция "от лица юзера", как просила подруга
            if (d.corrections) {
                parts.push(`hey, heads up: ${d.corrections}`);
            }
            if (d.character?.health) {
                parts.push(`btw health-wise rn: ${d.character.health}`);
            }
            if (d.character?.restrictions) {
                parts.push(`remember the character literally cannot: ${d.character.restrictions}`);
            }
            if (d.npcs?.reactions) {
                parts.push(`also npcs should be reacting like: ${d.npcs.reactions}`);
            }
        } else {
            // Formal/neutral style
            if (d.corrections) {
                parts.push(`[System Note: Realism corrections needed — ${d.corrections}]`);
            }
            if (d.character?.health) {
                parts.push(`[Health Status: ${d.character.health}]`);
            }
            if (d.character?.restrictions) {
                parts.push(`[Character Restrictions: ${d.character.restrictions}]`);
            }
            if (d.npcs?.reactions) {
                parts.push(`[Expected NPC Reactions: ${d.npcs.reactions}]`);
            }
        }

        return parts.join('\n');
    }

    // ─── Utils ──────────────────────────────────────────────────────
    _deepMerge(target, source) {
        const result = { ...target };
        for (const key of Object.keys(source)) {
            if (key.startsWith('_')) continue; // skip internal fields from source
            if (
                source[key] &&
                typeof source[key] === 'object' &&
                !Array.isArray(source[key]) &&
                target[key] &&
                typeof target[key] === 'object'
            ) {
                result[key] = this._deepMerge(target[key], source[key]);
            } else if (source[key] !== undefined && source[key] !== null && source[key] !== '') {
                result[key] = source[key];
            }
        }
        return result;
    }
}
