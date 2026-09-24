/**
 * LLM adapter using Google ADK (Agent Development Kit).
 *
 * Uses ADK's LlmAgent + InMemoryRunner for one-shot completions
 * against Gemini models. ADK reads the API key from the
 * GEMINI_API_KEY environment variable automatically.
 *
 * Environment variables:
 *   GEMINI_API_KEY   — Required. Google AI / Gemini API key.
 *   BUILDER_MODEL    — Optional. Model identifier (default: gemini-3.6-flash).
 */

import { LlmAgent, InMemoryRunner } from '@google/adk';

export interface LlmMessage {
	role: 'system' | 'user' | 'assistant';
	content: string;
}

export interface LlmResponse {
	text: string;
	usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface LlmAdapter {
	complete(messages: LlmMessage[]): Promise<LlmResponse>;
}

export class HostedLlmAdapter implements LlmAdapter {

	private _model: string;

	constructor() {
		this._model = process.env.BUILDER_MODEL || 'gemini-3.6-flash';

		if (!process.env.GEMINI_API_KEY) {
			console.error('[builder] GEMINI_API_KEY is not set — builder requests will fail');
		}
	}

	async complete(messages: LlmMessage[]): Promise<LlmResponse> {
		if (!process.env.GEMINI_API_KEY) {
			throw new Error('GEMINI_API_KEY environment variable is not set.');
		}

		const system_parts: string[] = [];
		const conversation_parts: { role: string; text: string }[] = [];

		for (const msg of messages) {
			if (msg.role === 'system') {
				system_parts.push(msg.content);
				continue;
			}
			conversation_parts.push({ role: msg.role, text: msg.content });
		}

		// ADK's instruction field resolves {var} as context template variables.
		// Builder prompts contain literal braces (e.g. docs.google.com/d/{id})
		// which ADK cannot escape. Prepend system content to the first user
		// message instead, keeping instruction empty.
		const system_prefix = system_parts.length > 0
			? system_parts.join('\n\n') + '\n\n---\n\n'
			: '';

		const combined_message = system_prefix +
			conversation_parts.map(p => p.text).join('\n\n');

		const agent = new LlmAgent({
			name: 'builder',
			model: this._model,
		});

		const runner = new InMemoryRunner({ agent, appName: 'cliqhub-builder' });

		const events = runner.runEphemeral({
			userId: 'builder',
			newMessage: { role: 'user', parts: [{ text: combined_message }] },
		});

		let result_text = '';
		let last_error = '';

		for await (const event of events) {
			if ((event as { errorMessage?: string }).errorMessage) {
				last_error = (event as { errorMessage: string }).errorMessage;
			}
			if (event.author !== 'builder') continue;
			if (!event.content?.parts) continue;
			for (const part of event.content.parts) {
				if ((part as { text?: string }).text) {
					result_text += (part as { text: string }).text;
				}
			}
		}

		if (!result_text && last_error) {
			throw new Error(`Gemini API error: ${last_error}`);
		}
		if (!result_text) {
			throw new Error('No text content in Gemini ADK response');
		}

		return { text: result_text };
	}
}
