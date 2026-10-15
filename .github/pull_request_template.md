## 📋 Descrição do Pull Request
<!-- Descreva de forma clara e objetiva o que este PR implementa ou corrige. -->

## 🔗 Issue Relacionada
<!-- Vincule a issue correspondente para fechamento automático ao fazer merge. Ex: Closes #12, Fixes #34 -->
Closes #

## 🏷️ Tipo de Alteração
- [ ] `feat`: Nova funcionalidade
- [ ] `fix`: Correção de bug
- [ ] `docs`: Documentação técnica ou guias
- [ ] `refactor`: Refatoração interna de código sem alteração de comportamento
- [ ] `chore` / `ci`: Tarefas de infraestrutura, dependências ou automação

---

## 🛡️ Checklist de Qualidade e Integridade (Obrigatório)
> **Atenção:** Em nenhuma hipótese testes automatizados ou smoke tests devem ser alterados, enfraquecidos ou ignorados apenas para forçar a passagem de uma implementação com defeito.

- [ ] Executei a checagem de tipos e não há erros de tipagem (`npm run typecheck` no backend).
- [ ] Todos os testes automatizados passaram localmente (`npm test -- --run` no backend).
- [ ] O smoke test de empacotamento do Worker foi validado com sucesso (`npx wrangler deploy --dry-run`).
- [ ] **Nenhum teste existente ou asserção foi afrouxado, comentado ou removido para mascarar falhas.**
- [ ] Atualizei a documentação relevante (como `docs/` ou `backend/AGENTS.md`) se houve alteração na arquitetura ou endpoints.

---

## 🧪 Como Validar Manualmente
<!-- Descreva comandos, payloads de exemplo (curl / postman) ou passos para reproduzir o teste. -->
```bash
# Exemplo de chamada para teste
```
