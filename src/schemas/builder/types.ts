import { z } from 'zod';

/**
 * Single Teams build resource — POST /v1/teams/build only.
 * `action` selects the operation (hard cut; no /build/* subpaths).
 */
export const teams_build_schema = z.object({
    action: z.enum(['generate', 'status', 'improve_role', 'suggest', 'validate', 'chat']),

    // generate
    intent: z.string().max(5000).optional(),

    // status
    job_id: z.string().optional(),

    // improve_role
    role_name: z.string().optional(),
    role_content: z.string().max(50000).optional(),
    team_name: z.string().optional(),
    team_description: z.string().optional(),
    phases: z.array(z.any()).optional(),
    instruction: z.string().optional(),
    description: z.string().optional(),
    roles: z.array(z.any()).optional(),

    // validate / chat
    team: z.any().optional(),
    message: z.string().max(5000).optional(),
    history: z.array(z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string(),
    })).optional(),
}).superRefine((body, ctx) => {
    switch (body.action) {
        case 'generate':
            if (!body.intent?.trim()) {
                ctx.addIssue({ code: 'custom', message: 'intent is required', path: ['intent'] });
            }
            break;
        case 'status':
            if (!body.job_id?.trim()) {
                ctx.addIssue({ code: 'custom', message: 'job_id is required', path: ['job_id'] });
            }
            break;
        case 'improve_role':
            if (!body.role_name?.trim()) {
                ctx.addIssue({ code: 'custom', message: 'role_name is required', path: ['role_name'] });
            }
            if (!body.role_content?.trim()) {
                ctx.addIssue({ code: 'custom', message: 'role_content is required', path: ['role_content'] });
            }
            break;
        case 'suggest':
            if (!body.team_name?.trim()) {
                ctx.addIssue({ code: 'custom', message: 'team_name is required', path: ['team_name'] });
            }
            break;
        case 'validate':
            if (body.team == null) {
                ctx.addIssue({ code: 'custom', message: 'team is required', path: ['team'] });
            }
            break;
        case 'chat':
            if (body.team == null) {
                ctx.addIssue({ code: 'custom', message: 'team is required', path: ['team'] });
            }
            if (!body.message?.trim()) {
                ctx.addIssue({ code: 'custom', message: 'message is required', path: ['message'] });
            }
            break;
    }
});

export type TeamsBuildInput = z.infer<typeof teams_build_schema>;
