# Decisões da Etapa 1

## Organização e persistência

`domain/` contém classes sem dependência de NestJS/ORM, com construtores privados, factories e transições explícitas. `application/financial-service.ts` coordena uma transação SQL por comando. Controllers validam o contrato e traduzem resultados para HTTP. Não há barramento interno, factories de repositórios ou camadas genéricas.

TypeORM foi escolhido pela familiaridade do candidato. `EntitySchema` mapeia registros de persistência separados das classes de domínio; o serviço chama `rehydrate` ao reconstruir o estado. Isso também evita depender da emissão de metadados de propriedades pelo transpiler do Bun. A injeção de dependências usa `@Inject` explícito e os DTOs informam seu tipo ao `ValidationPipe`.

`Money` usa `decimal.js`, precisão de 40 dígitos, operações imutáveis e strings de escala 2. Valores negativos existem no domínio para subtrações/diferenças; os contratos de entrada os recusam. Não há arredondamento de entradas inválidas. Limite: `999999999999999999.99`. O banco usa um domain sobre `numeric` com validação de escala/faixa; `numeric(20,2)` arredondaria entradas com casas excedentes antes da constraint. O driver PostgreSQL mantém decimais como strings. A API restringe moeda a BRL; o modelo preserva a moeda e impede operações entre moedas diferentes.

## Concorrência, atomicidade e histórico

O processamento bloqueia a linha da wallet com `SELECT FOR UPDATE` em `READ COMMITTED`. A leitura do saldo, decisão, atualização, transação e ledger ficam na mesma transação SQL. O lock é por wallet e funciona entre processos; wallets diferentes não compartilham lock. Locks são liberados no commit/rollback. Timeouts de lock/statement produzem falha transitória, sem retry automático HTTP.

A inserção da operação vem **depois** do lock da wallet para evitar upgrades concorrentes dos locks da FK. A unicidade no banco continua decidindo conflitos entre wallets/chaves. `ON CONFLICT DO NOTHING` permite consultar a operação vencedora em um novo statement sem manter uma transação SQL abortada por violação de unicidade.

O schema impõe unicidade player/moeda, chave global de idempotência, provider/ID externo e transação no ledger; valores não negativos; aritmética do lançamento; FKs; identidade/versão da wallet; bloqueio de UPDATE/DELETE/TRUNCATE do ledger e de alterações em transações terminais. Constraint triggers diferidos verificam no commit o vínculo entre transação processada e ledger e a igualdade `wallet.balance = soma do ledger`. A migration é reversível.

Essa verificação adicional soma o histórico da wallet no commit: custo O(n) por wallet, aceitável para o volume do desafio, mas seria preciso medir antes de adotar em produção. O serviço ainda usa lock explícito: constraints não substituem o controle de concorrência. O usuário de produção não deve ter privilégios para desabilitar triggers ou alterar schema; o Compose usa credenciais locais de desenvolvimento.

Abertura positiva gera `OPENING` interno e crédito, mantendo versão 1. Abertura zero não gera transação/ledger. Apenas alterações efetivas de saldo incrementam a versão; `LOSS` e rejeições não incrementam. `BET/WIN` exigem valor positivo; `LOSS` aceita valor não negativo apenas como informação, sem efeito financeiro.

## Idempotência e estados

O header é obrigatório, global e não é derivado silenciosamente. SHA-256 recebe UTF-8 de JSON canônico dos campos validados de negócio: provider, ID externo, player, wallet, round, game, kind e money. Chaves de objetos são ordenadas recursivamente; strings e arrays preservam conteúdo/ordem. Header e transporte ficam fora do hash. Campos extras são recusados pela API.

Mesmo header + mesmo payload retorna ID, status, falha e **saldo originais** persistidos, mudando apenas `idempotentReplay` para true. Mesmo header com outro payload retorna `IDEMPOTENCY_CONFLICT` (409). Mesmo provider/ID externo com outra chave retorna `EXTERNAL_TRANSACTION_CONFLICT` (409), mesmo que o payload seja igual. Operações rejeitadas também são persistidas e reproduzidas; um depósito posterior não transforma a mesma aposta rejeitada em débito.

Nesta etapa, `PENDING → PROCESSED | REJECTED` ocorre dentro da transação SQL, sem `PENDING` confirmado isoladamente. Estados terminais não admitem nova transição. `FAILED` está reservado no schema/modelo para falhas permanentes auditáveis da etapa de mensageria; não é emitido pelo fluxo atual. Falhas transitórias fazem rollback e permitem reenvio com a mesma chave. `PENDING_REFERENCE` e suas transições serão adicionados com as referências na Etapa 2.

| Código de rejeição (422) | Motivo |
| --- | --- |
| `INSUFFICIENT_FUNDS` | Saldo insuficiente para BET |
| `PLAYER_MISMATCH` | Player não é o dono da wallet |
| `CURRENCY_MISMATCH` | Moeda da operação difere da wallet |
| `BALANCE_LIMIT_EXCEEDED` | Crédito excederia o limite monetário |

Moeda diferente chega ao caso de uso como rejeição auditável; o contrato HTTP desta etapa recusa moedas além de BRL com 400. Payload malformado ou wallet inexistente não é uma operação aceita e não cria transação.

## Limites e próximos passos

Não há autenticação. `ProviderAuthGuard` é o ponto de extensão explícito: uma implementação futura validaria tokens OIDC de IdP externo e autorizaria o provider da requisição; não haverá tabela própria de senhas. A API local confia no provider informado.

Etapa 2: referências (inclusive WIN opcional), REFUND, ROLLBACK, pendências fora de ordem, reprocessamento e reconciliação. Etapa 3: inbox/outbox, eventos tipados, SQS, workers, retry/backoff, DLQ e shutdown de mensagens. **Nenhum evento é publicado nesta etapa e ainda não há registro de eventos para publicação futura.** Não se deve interpretar esta versão como tendo as garantias de entrega do desafio completo.

Etapa 4: health de processo/dependências, correlação e métricas completas, testes reais em três processos e recuperação após falhas de workers. A paginação atual usa sequência global crescente codificada com o walletId em base64url; é estável para operações da mesma wallet porque são serializadas no banco. Não é um snapshot: novos lançamentos podem aparecer nas páginas seguintes.

Na validação em Windows, matchers assíncronos `expect(promise).rejects.toThrow` provocaram timeouts/crashes no Bun 1.4.3 e 1.3.14. Os testes de integração aguardam a operação em `try/catch` e verificam a exceção recebida. A suíte passou com esse formato no Bun 1.3.14, versão fixada para reprodução.
