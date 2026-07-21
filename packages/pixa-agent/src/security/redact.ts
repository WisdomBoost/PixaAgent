
interface SecretPattern {
    name: string;
    regex: RegExp;
}

const PATTERNS: SecretPattern[] = [
    { name: "aws-access-key", regex: /AKIA[0-9A-Z]{16}/g },
    { name: "aws-secret-key", regex: /(?<=aws_secret_access_key\s*[:=]\s*)['"]?[A-Za-z0-9/+=]{40}['"]?/gi },
    { name: "openai-key", regex: /sk-[A-Za-z0-9]{20,}/g },
    { name: "anthropic-key", regex: /sk-ant-[A-Za-z0-9-_]{20,}/g },
    { name: "github-token", regex: /gh[pousr]_[A-Za-z0-9]{36,}/g },
    { name: "generic-bearer", regex: /Bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g },
    { name: "private-key-block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
    { name: "jwt", regex: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
    {
        name: "generic-assigned-secret",
        // e.g. api_key = "abc123...", password: 'xyz', token=...
        regex: /(?<=\b(?:api[_-]?key|secret|password|token|access[_-]?key)\s*[:=]\s*)['"][^'"\s]{8,}['"]/gi,
    },
];

export function redactSecrets(text: string): string {
    let result = text;
    for (const { regex } of PATTERNS) {
        result = result.replace(regex, "[REDACTED]");
    }
    return result;
}