# Global Developer Context & Engineering Guidelines

## 1. Environment & Technical Stack
- **OS**: Cross-platform (Ubuntu Linux on personal PC, Windows / WSL2 / Git Bash on work PC).
- **Primary Languages**: JavaScript (JS), TypeScript (TS), PHP (8+).
- **Runtimes & Frameworks**: Node.js, Express, NestJS, Laravel.
- **Architecture Philosophy**: Clean Architecture, Domain-Driven Design (DDD), SOLID, DRY.
- **Language Preferences**: 
  - Respond and interact in **Spanish**.
  - Write code, inline documentation, commit messages, and variable names in **English**.

## 2. Core Code Quality & Architecture Standards
- **Layer Separation**: Enforce strict separation between Presentation, Domain, and Infrastructure layers.
- **Domain Integrity**: The domain layer must remain pure with no external framework or driver dependencies.
- **Type Safety**: Enforce strict typing (no `any` in TypeScript, explicit return types in PHP/Node). Use DTOs for request/response validation.
- **Error Handling**: Use domain-specific custom exceptions instead of throwing generic errors.
- **Testing**: Write unit/integration tests for critical business logic (Jest / PHPUnit mindset).
- **API Standards**: Design RESTful APIs conforming to OpenAPI/Swagger specifications.

## 3. Terminal & Execution Safety Guardrails
- **Cross-Platform Commands**: Prefer POSIX/Bash syntax when using Git Bash/WSL. Check OS environment before running OS-specific system tools.
- **Destructive Commands**: ALWAYS prompt for explicit user confirmation before executing destructive commands (e.g., `rm -rf`, `git reset --hard`, `git push --force`, dropping database tables, or modifying environment variables).
- **Secrets Management**: Never write or commit hardcoded credentials, API keys, or JWT secrets. Always use `.env` patterns.
- **Non-Interactive Commands**: Prefer clean, non-blocking CLI flags when running scripts or system commands.

## 4. Interaction & Output Format
- **Direct & Actionable**: Provide code solutions first, followed by concise explanations of architectural tradeoffs.
- **Refactoring Strategy**: When suggesting refactorings, prioritize readability, maintainability, and loose coupling.
- **Read-Only Tasks**: If a request is purely diagnostic or informational, do not generate code modification plans unless requested.
