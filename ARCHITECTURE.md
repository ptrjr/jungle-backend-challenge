# Decisões de arquitetura

## Domínio e persistência

`domain/` contém classes sem dependências de NestJS ou ORM, com factories, construtores privados/protegidos e transições explícitas. `rehydrate` reconstrói estado persistido sem reaplicar regras de transição. `FinancialService` coordena o caso de uso compartilhado por HTTP e SQS. Controllers validam contratos; `EntitySchema` separa os registros TypeORM das classes de domínio e evita dependência de decorators de persistência no domínio.

TypeORM oferece transações e locks PostgreSQL explícitos, mantendo o fluxo financeiro em um único `EntityManager`. A injeção usa `@Inject` explícito e os DTOs informam seu tipo ao `ValidationPipe`, compatível com o transpiler do Bun.

`Money` usa `decimal.js` com precisão de 40 dígitos, operações imutáveis e strings de escala 2. O limite é `999999999999999999.99`; entradas inválidas não são arredondadas. O banco usa um domain sobre `numeric` que valida escala e faixa: `numeric(20,2)` arredondaria antes da constraint. O driver mantém decimais como strings. BRL é a única moeda exposta; o domínio mantém moeda e rejeita operações incompatíveis. Diferenças negativas existem no domínio/reconciliação, mas não nos contratos de entrada.

## Identidade, validação e hashes

Player/wallet UUIDs são normalizados antes da criação de entidades, hash e eventos no serviço compartilhado. A abertura segue a mesma política. Consultas PostgreSQL tratam UUIDs sem diferença de caixa; paginação e reconciliação também canonicalizam os identificadores que retornam/comparam. Provider, ID externo, rodada, jogo e chave de idempotência preservam caixa.

SHA-256 recebe JSON canônico de provider, ID externo, player, wallet, round, game, kind, money e referência opcional. As chaves de objetos são ordenadas recursivamente; transporte e header ficam fora. A inbox acrescenta a chave de idempotência ao seu hash. UUIDs são normalizados em ambos os cálculos.

Hashes históricos podem conter UUIDs com outra grafia. Em um replay cujo hash não coincide, o serviço compara o hash canônico dos campos de negócio imutáveis já persistidos. A inbox faz a mesma verificação pela transação vinculada, incluindo sua chave. Isso aceita equivalência de UUID sem ignorar diferenças nos demais campos e sem reescrever hashes, saldos ou resultados. Uma rejeição antiga continua rejeitada, mesmo que a causa tenha sido corrigida.

DTOs HTTP/SQS compartilham a rejeição de NUL. Headers e identificadores de negócio em rotas também são verificados. Erros SQL de integridade não são convertidos genericamente em 400. CorrelationId é opcional, tem até 128 caracteres, sem NUL ou espaços nas extremidades; no SQS, omissão usa messageId.

## Transação, locks e ledger

Uma operação usa `READ COMMITTED` e `SELECT FOR UPDATE` na wallet. Leitura, decisão, transação financeira, saldo, ledger e eventos ficam no mesmo commit. A inserção da operação ocorre depois do lock da wallet para evitar upgrades concorrentes dos locks da FK. `ON CONFLICT DO NOTHING` permite consultar a operação vencedora em novo statement sem manter uma transação abortada. A unidade de lock é a wallet, sem lock global.

Unicidades no schema protegem player/moeda, chave global, provider/ID externo, transação do ledger e reversão por referência/tipo. Há FKs, escala, não-negatividade, aritmética dos lançamentos e proteção da versão da wallet. Triggers impedem UPDATE/DELETE/TRUNCATE do ledger e alteração de transações terminais. Constraint triggers diferidos conferem vínculo financeiro/ledger e `wallet.balance = soma do ledger` no commit.

A soma adicional custa O(n) por wallet. Não causou timeout nos cenários exercitados, mas histórico longo exige medição antes de produção. O usuário de aplicação não deve ter privilégios para desabilitar triggers ou alterar schema; o Compose usa credenciais de desenvolvimento.

Abertura positiva cria OPENING interno e crédito, com versão 1; abertura zero não cria movimento. Somente mudanças de saldo incrementam versão. LOSS e rejeições não geram ledger. BET/WIN exigem valor positivo; LOSS permite valor não negativo informativo.

## Idempotência, referências e estados

Mesmo header/payload retorna ID, estado e saldo originais, com replay indicado. Outra chave para o mesmo provider/ID externo é conflito, assim como a mesma chave com outro payload. As garantias estão no PostgreSQL, não em cache ou FIFO.

`PENDING → PROCESSED | REJECTED | PENDING_REFERENCE` ocorre dentro da transação. Pendências podem continuar aguardando ou terminar. Estados terminais são imutáveis. `FAILED` permanece reservado: falhas que impedem commit fazem rollback/retry e, quando esgotadas, são auditadas por DLQ/logs; não se cria uma transação artificial depois do rollback.

Referências são resolvidas exclusivamente por `(providerId, referenceExternalTransactionId)`. Um ID em outro provider continua ausente no escopo consultado. A referência deve coincidir com player, wallet, moeda e rodada. REFUND aceita BET; ROLLBACK aceita BET/WIN/REFUND e inverte o efeito; WIN referenciado aceita BET. Reversões exigem valor integral e permitem uma aplicação por tipo sobre a mesma referência, conforme o enunciado.

| FailureCode | Significado |
| --- | --- |
| `INSUFFICIENT_FUNDS` | BET sem saldo |
| `REVERSAL_INSUFFICIENT_FUNDS` | Reversão produziria saldo negativo |
| `PLAYER_MISMATCH`, `CURRENCY_MISMATCH` | Identidade da operação incompatível com a wallet |
| `BALANCE_LIMIT_EXCEEDED` | Crédito ultrapassaria o limite |
| `INVALID_REFERENCE`, `REFERENCE_*_MISMATCH` | Autorreferência ou identidade/tipo/valor incompatível |
| `REFERENCE_ALREADY_REVERSED` | Reversão do mesmo tipo já processada |
| `REFERENCE_NOT_FOUND` | Referência ausente ao esgotar tentativas |
| `REFERENCE_NOT_PROCESSED` | Referência rejeitada/falha, ou ainda pendente no esgotamento |

O worker seleciona primeiro wallet, depois transação, com `SKIP LOCKED`, preservando a ordem de locks do caso HTTP. Agenda/tentativas são persistidas. São oito reprocessamentos com backoff de 5 segundos até 300 segundos, cerca de 15 minutos com serviço disponível. O limite é por tentativas, não TTL; indisponibilidade prolonga o prazo. Falha SQL desfaz também o contador. Replay não antecipa a agenda. Após commit, resolução/expiração geram log estruturado com identidade, correlação, estado e failureCode disponível; tentativas confirmadas alimentam a métrica de latência existente.

## Inbox, outbox e entrega

O consumer valida o envelope e abre a transação da inbox por `(consumerName, messageId)`. A mesma transação SQL contém operação, saldo, ledger, recibo e eventos. O ack ocorre somente depois do commit; falha no ack permite redelivery sem novo efeito financeiro. Inbox conflitante é erro permanente.

Os quatro eventos concretos herdam `IntegrationEvent`, com envelope versionado e Money como strings. OPENING gera eventos; LOSS produz somente Processed. PendingReference é emitido uma vez; resolução/expiração geram o evento terminal. O worker recupera a correlação original do evento pendente. Há unicidade por transação/tipo e proteção de payload/identidade no banco.

O publisher mantém lock de uma linha da outbox via `FOR UPDATE SKIP LOCKED` durante envio e confirmação. Não bloqueia wallet; ocupa uma conexão durante chamada de rede, limitada a cinco segundos. Essa opção evita protocolo de lease adicional. Backoff persistido vai de 1 segundo a 5 minutos, sem descarte por esgotamento. Tentativas contabilizam resultados confirmados; uma tentativa interrompida pode voltar sem incremento por rollback.

Não há transação distribuída SQL/SQS. Morte depois do envio e antes da confirmação pode repetir o mesmo eventId. Deduplication IDs de transporte são distintos por tentativa; o consumidor externo deve deduplicar por eventId. Publishers podem alterar a ordem de eventos da wallet; `walletVersion` informa a sequência financeira nos eventos de saldo.

## Falhas, shutdown e observabilidade

As filas de solicitações, DLQ e eventos são separadas. Erros financeiros são resultados terminais persistidos com ack. Contratos inválidos, recursos inexistentes ou conflitos seguem à DLQ explicitamente antes de remover o original; falha nesse intervalo também pode duplicar a cópia. Falhas transitórias têm backoff por visibilidade e redrive após cinco recebimentos. Visibilidade normal: 60 segundos com heartbeat. Os testes privados usam três recebimentos para acelerar a verificação. Redrive operacional não tem endpoint automático.

Cada instância consome uma mensagem por vez e publica até 25 eventos por rodada. Em SIGTERM, para novas buscas e aguarda trabalho em andamento antes de fechar o DataSource. O Compose concede 45 segundos. Em morte forçada, visibilidade expira e locks SQL são liberados; estado persistido decide a retomada.

Logs JSON usam os identificadores disponíveis, sem payload financeiro completo. Métricas cobrem estados, duplicatas, retries, DLQ aproximada, locks, publicações, pendências/lag e latência. Contadores são por processo. Liveness verifica processo; readiness consulta PostgreSQL e as três filas, sem autenticação.

Reconciliação usa uma única consulta agregada: saldo e ledger pertencem ao mesmo snapshot. Diferença é armazenado menos calculado, em `numeric`; contagem de entradas usa number. Divergências geram resposta, log e métrica, sem correção automática. Paginação crescente usa cursor com wallet/sequence e não representa snapshot entre páginas.

## Migrations e limites operacionais

As três migrations são versionadas. Down/up completo é suportado em schema vazio. O comando de downgrade mantém locks de tabela na mesma transação da verificação e recusa apagar histórico financeiro/inbox/outbox. A migration de referências recusa histórico incompatível com o schema anterior. Chamadas diretas ao ORM por um administrador continuam capazes de executar os `down` destrutivos originais; use o comando documentado.

O LocalStack 4.10.0 utilizado não demonstrou durabilidade SQS após restart, mesmo com volume, persistência habilitada, snapshots explícitos e encerramento com prazo de 45 segundos. O diagnóstico mede esse comportamento; a aceitação estrita exige sobrevivência e falha quando há perda. A configuração é de desenvolvimento. A investigação e suas fontes estão em [docs/VALIDATION.md](docs/VALIDATION.md).

A outbox recupera eventos pendentes no PostgreSQL. Eventos já marcados como publicados permanecem auditáveis no SQL, mas não são reenviados automaticamente caso o broker perca dados. Solicitações ainda não confirmadas dependem da retenção do broker ou reenvio do produtor. Durabilidade efetiva do broker e recuperação operacional são necessárias para uso real. Não há backfill de eventos anteriores à instalação da outbox nem replay administrativo.

Autenticação foi omitida conforme permitido no desafio. `ProviderAuthGuard` é o ponto de extensão para validar OIDC de IdP externo e autorizar provider; não haveria tabela própria de senhas. O canal SQS local é interno confiável, com identidade ainda validada pelo domínio.
