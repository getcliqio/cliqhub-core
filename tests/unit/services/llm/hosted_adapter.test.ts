import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/* ─── Mock ADK ───────────────────────────────────────────────── */

const mock_run_ephemeral = vi.fn();

vi.mock('@google/adk', () => {
    const LlmAgent = vi.fn(function LlmAgent(
        this: { name: unknown; model: unknown; instruction: unknown },
        config: Record<string, unknown>,
    ) {
        this.name = config.name;
        this.model = config.model;
        this.instruction = config.instruction;
    });
    const InMemoryRunner = vi.fn(function InMemoryRunner(this: { runEphemeral: typeof mock_run_ephemeral }) {
        this.runEphemeral = mock_run_ephemeral;
    });
    return { LlmAgent, InMemoryRunner };
});

import { HostedLlmAdapter } from '../../../../src/services/llm/hosted_adapter.js';
import { LlmAgent, InMemoryRunner } from '@google/adk';

/* ─── Helpers ────────────────────────────────────────────────── */

function make_events(text: string) {
    const events = [
        { author: 'user', content: { parts: [{ text: 'input' }] } },
        { author: 'builder', content: { parts: [{ text }] } },
    ];
    return async function* () {
        for (const e of events) yield e;
    };
}

function make_empty_events() {
    return async function* () {
        yield { author: 'builder', content: { parts: [] } };
    };
}

/* ─── Tests ──────────────────────────────────────────────────── */

describe('HostedLlmAdapter (ADK)', () => {
    const original_env = { ...process.env };

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.GEMINI_API_KEY = 'test-gemini-key';
        process.env.BUILDER_MODEL = '';
    });

    afterEach(() => {
        process.env = { ...original_env };
    });

    it('prepends system messages to user message (not as instruction)', async () => {
        mock_run_ephemeral.mockReturnValueOnce(make_events('hello')());

        const adapter = new HostedLlmAdapter();
        await adapter.complete([
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Say hi' },
        ]);

        expect(LlmAgent).toHaveBeenCalledWith(expect.objectContaining({
            name: 'builder',
            model: 'gemini-3.6-flash',
        }));
        expect(LlmAgent).toHaveBeenCalledWith(
            expect.not.objectContaining({ instruction: expect.anything() }),
        );
        expect(mock_run_ephemeral).toHaveBeenCalledWith(expect.objectContaining({
            newMessage: {
                role: 'user',
                parts: [{ text: 'You are helpful.\n\n---\n\nSay hi' }],
            },
        }));
    });

    it('joins multiple system messages and prepends to user message', async () => {
        mock_run_ephemeral.mockReturnValueOnce(make_events('ok')());

        const adapter = new HostedLlmAdapter();
        await adapter.complete([
            { role: 'system', content: 'Rule 1' },
            { role: 'system', content: 'Rule 2' },
            { role: 'user', content: 'Go' },
        ]);

        expect(mock_run_ephemeral).toHaveBeenCalledWith(expect.objectContaining({
            newMessage: {
                role: 'user',
                parts: [{ text: 'Rule 1\n\nRule 2\n\n---\n\nGo' }],
            },
        }));
    });

    it('combines conversation parts with system prefix', async () => {
        mock_run_ephemeral.mockReturnValueOnce(make_events('result')());

        const adapter = new HostedLlmAdapter();
        await adapter.complete([
            { role: 'system', content: 'Be brief.' },
            { role: 'user', content: 'Question 1' },
            { role: 'assistant', content: 'Answer 1' },
            { role: 'user', content: 'Question 2' },
        ]);

        expect(mock_run_ephemeral).toHaveBeenCalledWith(expect.objectContaining({
            newMessage: {
                role: 'user',
                parts: [{ text: 'Be brief.\n\n---\n\nQuestion 1\n\nAnswer 1\n\nQuestion 2' }],
            },
        }));
    });

    it('returns text from builder events', async () => {
        mock_run_ephemeral.mockReturnValueOnce(make_events('generated output')());

        const adapter = new HostedLlmAdapter();
        const result = await adapter.complete([
            { role: 'user', content: 'test' },
        ]);

        expect(result.text).toBe('generated output');
    });

    it('concatenates text from multiple builder events', async () => {
        const events = async function* () {
            yield { author: 'builder', content: { parts: [{ text: 'part1' }] } };
            yield { author: 'builder', content: { parts: [{ text: 'part2' }] } };
        };
        mock_run_ephemeral.mockReturnValueOnce(events());

        const adapter = new HostedLlmAdapter();
        const result = await adapter.complete([{ role: 'user', content: 'test' }]);

        expect(result.text).toBe('part1part2');
    });

    it('ignores non-builder events', async () => {
        const events = async function* () {
            yield { author: 'user', content: { parts: [{ text: 'ignored' }] } };
            yield { author: 'builder', content: { parts: [{ text: 'kept' }] } };
        };
        mock_run_ephemeral.mockReturnValueOnce(events());

        const adapter = new HostedLlmAdapter();
        const result = await adapter.complete([{ role: 'user', content: 'test' }]);

        expect(result.text).toBe('kept');
    });

    it('uses custom model from BUILDER_MODEL env', async () => {
        process.env.BUILDER_MODEL = 'gemini-2.5-pro';
        mock_run_ephemeral.mockReturnValueOnce(make_events('ok')());

        const adapter = new HostedLlmAdapter();
        await adapter.complete([{ role: 'user', content: 'test' }]);

        expect(LlmAgent).toHaveBeenCalledWith(expect.objectContaining({
            model: 'gemini-2.5-pro',
        }));
    });

    it('defaults to gemini-3.6-flash when BUILDER_MODEL is not set', async () => {
        delete process.env.BUILDER_MODEL;
        mock_run_ephemeral.mockReturnValueOnce(make_events('ok')());

        const adapter = new HostedLlmAdapter();
        await adapter.complete([{ role: 'user', content: 'test' }]);

        expect(LlmAgent).toHaveBeenCalledWith(expect.objectContaining({
            model: 'gemini-3.6-flash',
        }));
    });

    it('throws when GEMINI_API_KEY is not set', async () => {
        delete process.env.GEMINI_API_KEY;

        const adapter = new HostedLlmAdapter();
        await expect(adapter.complete([{ role: 'user', content: 'test' }]))
            .rejects.toThrow('GEMINI_API_KEY environment variable is not set');
    });

    it('throws when response has no text content', async () => {
        mock_run_ephemeral.mockReturnValueOnce(make_empty_events()());

        const adapter = new HostedLlmAdapter();
        await expect(adapter.complete([{ role: 'user', content: 'test' }]))
            .rejects.toThrow('No text content in Gemini ADK response');
    });

    it('surfaces ADK errorMessage when no text content', async () => {
        const events = async function* () {
            yield {
                author: 'builder',
                content: { parts: [] },
                errorMessage: 'Resource exhausted. Please try again later.',
            };
        };
        mock_run_ephemeral.mockReturnValueOnce(events());

        const adapter = new HostedLlmAdapter();
        await expect(adapter.complete([{ role: 'user', content: 'test' }]))
            .rejects.toThrow('Gemini API error: Resource exhausted. Please try again later.');
    });

    it('creates InMemoryRunner with correct appName', async () => {
        mock_run_ephemeral.mockReturnValueOnce(make_events('ok')());

        const adapter = new HostedLlmAdapter();
        await adapter.complete([{ role: 'user', content: 'test' }]);

        expect(InMemoryRunner).toHaveBeenCalledWith(expect.objectContaining({
            appName: 'cliqhub-builder',
        }));
    });
});
