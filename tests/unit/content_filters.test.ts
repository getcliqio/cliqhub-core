/**
 * Unit tests for content filters (guardrails on agent messages).
 *
 * Tests the pure apply_content_filters function with default and
 * custom rules.
 */

import { describe, it, expect } from 'vitest';
import {
    apply_content_filters,
    type ContentFilterRule,
} from '../../src/services/review_message.service.js';


describe('apply_content_filters — default rules', () => {

    it('passes clean text through unchanged', () => {
        const result = apply_content_filters('This is a normal message about code architecture.');
        expect(result.blocked).toBe(false);
        expect(result.text).toBe('This is a normal message about code architecture.');
        expect(result.warnings).toHaveLength(0);
    });

    it('redacts Anthropic API keys', () => {
        const text = 'Here is the key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890';
        const result = apply_content_filters(text);
        expect(result.blocked).toBe(false);
        expect(result.text).toContain('[REDACTED_KEY]');
        expect(result.text).not.toContain('sk-ant-api03');
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].action).toBe('redact');
    });

    it('redacts OpenAI API keys', () => {
        const text = 'Use sk-proj-abcdefghijklmnopqrstuvwxyz for the API';
        const result = apply_content_filters(text);
        expect(result.blocked).toBe(false);
        expect(result.text).toContain('[REDACTED_KEY]');
        expect(result.text).not.toContain('sk-proj');
    });

    it('redacts GitHub personal access tokens', () => {
        const text = 'Token: ghp_abcdefghijklmnopqrstuvwxyz1234567890';
        const result = apply_content_filters(text);
        expect(result.blocked).toBe(false);
        expect(result.text).toContain('[REDACTED_KEY]');
        expect(result.text).not.toContain('ghp_');
    });

    it('redacts AWS access keys', () => {
        const text = 'AWS key AKIAIOSFODNN7EXAMPLE is exposed';
        const result = apply_content_filters(text);
        expect(result.blocked).toBe(false);
        expect(result.text).toContain('[REDACTED_AWS_KEY]');
        expect(result.text).not.toContain('AKIAIOSFODNN7EXAMPLE');
    });

    it('redacts private keys', () => {
        const text = 'Here is the key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...\n-----END RSA PRIVATE KEY-----';
        const result = apply_content_filters(text);
        expect(result.blocked).toBe(false);
        expect(result.text).toContain('[REDACTED_PRIVATE_KEY]');
        expect(result.text).not.toContain('BEGIN RSA PRIVATE KEY');
    });

    it('redacts multiple secrets in one message', () => {
        const text = 'Keys: sk-abcdefghijklmnopqrstuvwx, also AKIAIOSFODNN7EXAMPLE';
        const result = apply_content_filters(text);
        expect(result.blocked).toBe(false);
        expect(result.text).toContain('[REDACTED_KEY]');
        expect(result.text).toContain('[REDACTED_AWS_KEY]');
        expect(result.warnings).toHaveLength(2);
    });
});


describe('apply_content_filters — custom rules', () => {

    it('warn action logs but stores the message unchanged', () => {
        const rules: ContentFilterRule[] = [
            { pattern: 'password', action: 'warn', label: 'password_mention' },
        ];
        const result = apply_content_filters('The password is secret123', rules);
        expect(result.blocked).toBe(false);
        expect(result.text).toBe('The password is secret123');
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].action).toBe('warn');
        expect(result.warnings[0].label).toBe('password_mention');
    });

    it('redact action replaces match with custom replacement', () => {
        const rules: ContentFilterRule[] = [
            { pattern: '\\d{3}-\\d{2}-\\d{4}', action: 'redact', label: 'ssn', replacement: '[SSN]' },
        ];
        const result = apply_content_filters('SSN is 123-45-6789', rules);
        expect(result.blocked).toBe(false);
        expect(result.text).toBe('SSN is [SSN]');
        expect(result.warnings[0].action).toBe('redact');
    });

    it('block action rejects the message', () => {
        const rules: ContentFilterRule[] = [
            { pattern: 'DROP TABLE', action: 'block', label: 'sql_injection' },
        ];
        const result = apply_content_filters('Try this: DROP TABLE users;', rules);
        expect(result.blocked).toBe(true);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].action).toBe('block');
    });

    it('block stops processing — later rules not evaluated', () => {
        const rules: ContentFilterRule[] = [
            { pattern: 'blocked_word', action: 'block', label: 'blocker' },
            { pattern: 'secret', action: 'redact', label: 'secret_leak' },
        ];
        const result = apply_content_filters('blocked_word and secret here', rules);
        expect(result.blocked).toBe(true);
        /** Only the block warning, not the redact. */
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].label).toBe('blocker');
    });

    it('empty rules array passes everything through', () => {
        const result = apply_content_filters('anything goes', []);
        expect(result.blocked).toBe(false);
        expect(result.text).toBe('anything goes');
        expect(result.warnings).toHaveLength(0);
    });

    it('invalid regex pattern is skipped gracefully', () => {
        const rules: ContentFilterRule[] = [
            { pattern: '(unclosed', action: 'block', label: 'bad_regex' },
        ];
        const result = apply_content_filters('normal text', rules);
        expect(result.blocked).toBe(false);
        expect(result.warnings).toHaveLength(0);
    });
});
