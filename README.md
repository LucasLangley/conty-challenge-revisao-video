# Revisão de vídeo

API de revisão de entregas de campanha. Uma entrega tem peças (`script`, `video`, `cover`, `caption`), cada peça tem versões, e a marca aprova ou pede ajuste em cada versão. Comentários de vídeo ficam presos a um segundo da versão em que foram feitos.

A regra central: **a entrega só fica aprovada (e pagável) quando cada peça que a campanha exige tem a versão atual aprovada.**

## Como rodar

Node 22.

```bash
npm install
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm start          # http://127.0.0.1:3008 (PORT muda a porta)
```

Os dados ficam em memória e somem quando o processo para. Upload é só uma `url` (aceita `fake://...`).

## Modelo

- **Campanha** declara `required_pieces`. A lista é dado da campanha; nenhuma parte do código pergunta "é vídeo?" para decidir o que exige.
- **Entrega** pertence a uma campanha e a um criador.
- **Versão** pertence a uma entrega e a uma peça, com número sequencial por peça. A versão atual é a de maior número; as anteriores ficam como histórico. Vídeo exige `duration_seconds > 0`.
- **Comentário** pertence a uma versão (`version_id`), com `at_second` entre `0` e a duração daquela versão (os dois extremos valem; aceita fração).
- **Eventos** por entrega: `version.submitted`, `version.approved`, `version.changes_requested`, `delivery.approved`, `delivery.approval_revoked`, `delivery.approval_restored`.

A regra está em `src/domain.ts` (funções puras). `src/service.ts` orquestra repositório, relógio e eventos; `src/app.ts` é só HTTP; `src/store.ts` tem a interface `Repository` e a implementação em memória.

## Decisões e regras

- **Status da entrega é derivado, nunca guardado.** A cada leitura:
  - `in_production`: alguma peça exigida não tem versão, ou a versão atual está `in_review` ou `changes_requested`;
  - `awaiting_approval`: todas as peças exigidas têm a versão atual aprovada, mas a marca ainda não assinou a entrega;
  - `approved`: as duas coisas acima, e a marca assinou (`POST /deliveries/:id/approve`).
  - `payable` é `status === "approved"`.
- **Assinar a entrega** (`signed_off_at`) é o ato da marca e fica registrado. Sozinho ele não aprova nada: se uma peça exigida recebe versão nova, o status volta para `in_production` e é gravado `delivery.approval_revoked` (com a versão anterior e a nova).
- **Volta automática.** O enunciado diz que a entrega deixa de estar aprovada "até a nova versão ser aprovada". Por isso, quando a versão nova é aprovada e a marca já tinha assinado, a entrega volta a `approved` sem nova assinatura, e é gravado `delivery.approval_restored`. Se preferir exigir nova assinatura, basta trocar a regra em `deliveryStatus` para comparar as versões assinadas (já guardadas no evento `delivery.approved`) com as atuais.
- **Peça que a campanha não pediu** pode receber versões, mas não entra em `pending`, não bloqueia a aprovação e versão nova nela não revoga nada.
- **Só a versão atual e ainda em revisão recebe decisão.** Aprovar ou pedir ajuste numa versão substituída dá 409; mudar de ideia sobre uma versão já decidida também (o caminho é mandar versão nova).
- **Comentário não migra.** Ele aponta para a versão em que foi feito; a versão nova começa sem comentários, e os da anterior continuam visíveis em `GET /versions/:id` da anterior.
- Comentário com tempo só existe em versão de vídeo (as outras peças não têm duração).
- Assinar uma entrega já assinada e ainda aprovada não grava evento novo (é idempotente).
- Erros: 422 para entrada inválida, 404 para recurso inexistente, 409 para conflito de regra (`code: "required_pieces_pending"` lista as pendências em `pending`).
- Horários vêm de um `Clock` injetável; os testes usam um relógio fixo. IDs são sequenciais por tipo (`cmp_1`, `dlv_1`, `ver_1`...).

## Endpoints

Exemplos gerados rodando o app (`npm start`) com uma campanha que exige vídeo e capa. Respostas longas aparecem como trecho, indicado.

| Método | Rota | O que faz |
|---|---|---|
| POST | `/campaigns` | cria campanha `{name, required_pieces}` |
| POST | `/deliveries` | cria entrega `{campaign_id, creator_id}` |
| GET | `/deliveries/:id` | entrega, status, payable, pendências, peças e eventos |
| POST | `/deliveries/:id/approve` | assina a entrega (409 se faltar peça exigida) |
| POST | `/deliveries/:id/pieces/:kind/versions` | envia versão `{url, duration_seconds?}` |
| GET | `/versions/:id` | versão, se é a atual, e seus comentários (em ordem de segundo) |
| POST | `/versions/:id/approve` | aprova a versão |
| POST | `/versions/:id/request-changes` | pede ajuste `{note?}` |
| POST | `/versions/:id/comments` | comenta `{at_second, body}` |

### Criar campanha

```
POST /campaigns
{"name":"Lançamento tênis","required_pieces":["video","cover"]}

HTTP 201
{"id":"cmp_1","name":"Lançamento tênis","required_pieces":["video","cover"],"created_at":"2026-10-09T15:18:26.173Z"}
```

### Criar entrega

```
POST /deliveries
{"campaign_id":"cmp_1","creator_id":"crt_42"}

HTTP 201 (trecho)
{
  "delivery": {"id":"dlv_1","campaign_id":"cmp_1","creator_id":"crt_42","created_at":"2026-10-09T15:18:26.183Z","signed_off_at":null},
  "status": "in_production",
  "payable": false,
  "pending": [
    {"kind":"video","reason":"no_version","version_id":null,"message":"video: nenhuma versão enviada"},
    {"kind":"cover","reason":"no_version","version_id":null,"message":"cover: nenhuma versão enviada"}
  ],
  "pieces": [
    {"kind":"video","required":true,"current_version":null,"version_ids":[]},
    {"kind":"cover","required":true,"current_version":null,"version_ids":[]}
  ],
  "events": []
}
```

### Enviar versão de vídeo

```
POST /deliveries/dlv_1/pieces/video/versions
{"url":"fake://video-v1.mp4","duration_seconds":45}

HTTP 201
{
  "version": {"id":"ver_1","delivery_id":"dlv_1","kind":"video","number":1,"url":"fake://video-v1.mp4","duration_seconds":45,"status":"in_review","decision_note":null,"created_at":"2026-10-09T15:18:26.187Z","decided_at":null},
  "is_current": true,
  "comments": []
}
```

### Comentar num segundo

```
POST /versions/ver_1/comments
{"at_second":12,"body":"logo cortado aqui"}

HTTP 201
{"id":"cmt_1","version_id":"ver_1","at_second":12,"body":"logo cortado aqui","created_at":"2026-10-09T15:18:26.190Z"}
```

```
POST /versions/ver_1/comments
{"at_second":50,"body":"depois do fim"}

HTTP 422
{"error":"at_second precisa estar entre 0 e 45 (duração da versão 1)","code":"invalid"}
```

### Aprovar a entrega com peça faltando

Depois de `POST /versions/ver_1/approve` (vídeo aprovado), sem capa:

```
POST /deliveries/dlv_1/approve

HTTP 409
{
  "error": "a entrega não pode ser aprovada: cover: nenhuma versão enviada",
  "code": "required_pieces_pending",
  "pending": [
    {"kind":"cover","reason":"no_version","version_id":null,"message":"cover: nenhuma versão enviada"}
  ]
}
```

### Aprovar a entrega completa

Depois de enviar a capa (`ver_2`, `url: "https://cdn.exemplo.com/capa.png"`) e aprová-la:

```
POST /deliveries/dlv_1/approve

HTTP 200 (trecho)
{
  "delivery": {"id":"dlv_1", ..., "signed_off_at":"2026-10-09T15:18:26.202Z"},
  "status": "approved",
  "payable": true,
  "pending": [],
  "events": [
    ...,
    {"id":"evt_5","delivery_id":"dlv_1","type":"delivery.approved","at":"2026-10-09T15:18:26.202Z","data":{"version_ids":{"video":"ver_1","cover":"ver_2"}}}
  ]
}
```

### Versão nova numa entrega aprovada

```
POST /deliveries/dlv_1/pieces/video/versions
{"url":"fake://video-v2.mp4","duration_seconds":44}

HTTP 201 (trecho)
{"version":{"id":"ver_3","kind":"video","number":2,"status":"in_review", ...},"is_current":true,"comments":[]}
```

```
GET /deliveries/dlv_1

HTTP 200 (trecho)
{
  "status": "in_production",
  "payable": false,
  "pending": [
    {"kind":"video","reason":"in_review","version_id":"ver_3","message":"video: versão 2 ainda em revisão"}
  ],
  "events": [
    ...,
    {"id":"evt_6","delivery_id":"dlv_1","type":"version.submitted","at":"2026-10-09T15:18:26.205Z","data":{"version_id":"ver_3","kind":"video","number":2,"replaces_version_id":"ver_1"}},
    {"id":"evt_7","delivery_id":"dlv_1","type":"delivery.approval_revoked","at":"2026-10-09T15:18:26.205Z","data":{"kind":"video","previous_version_id":"ver_1","new_version_id":"ver_3","reason":"versão 2 de video enviada depois da aprovação"}}
  ]
}
```

### Decidir versão substituída e pedir ajuste

```
POST /versions/ver_1/request-changes
{"note":"áudio baixo"}

HTTP 409
{"error":"versão 1 foi substituída pela versão 2","code":"conflict","current_version_id":"ver_3"}
```

```
POST /versions/ver_3/request-changes
{"note":"áudio baixo no fim"}

HTTP 200 (trecho)
{"version":{"id":"ver_3","number":2,"status":"changes_requested","decision_note":"áudio baixo no fim","decided_at":"2026-10-09T15:18:26.211Z", ...},"is_current":true,"comments":[]}
```

### O comentário fica na versão em que foi feito

```
GET /versions/ver_1

HTTP 200
{
  "version": {"id":"ver_1","delivery_id":"dlv_1","kind":"video","number":1,"url":"fake://video-v1.mp4","duration_seconds":45,"status":"approved","decision_note":null,"created_at":"2026-10-09T15:18:26.187Z","decided_at":"2026-10-09T15:18:26.195Z"},
  "is_current": false,
  "comments": [
    {"id":"cmt_1","version_id":"ver_1","at_second":12,"body":"logo cortado aqui","created_at":"2026-10-09T15:18:26.190Z"}
  ]
}
```

```
GET /versions/ver_3

HTTP 200 (trecho)
{"version":{"id":"ver_3","number":2,"status":"changes_requested", ...},"is_current":true,"comments":[]}
```

### Versão nova aprovada: a entrega volta a aprovada

Depois de enviar `ver_4` (vídeo, versão 3) e `POST /versions/ver_4/approve`:

```
GET /deliveries/dlv_1

HTTP 200 (trecho)
{
  "status": "approved",
  "payable": true,
  "pending": [],
  "pieces": [
    {"kind":"video","required":true,"current_version":{"id":"ver_4","number":3,"status":"approved", ...},"version_ids":["ver_1","ver_3","ver_4"]},
    {"kind":"cover","required":true,"current_version":{"id":"ver_2","number":1,"status":"approved", ...},"version_ids":["ver_2"]}
  ],
  "events": [
    ...,
    {"id":"evt_10","delivery_id":"dlv_1","type":"version.approved","at":"2026-10-09T15:18:26.216Z","data":{"version_id":"ver_4","kind":"video","number":3,"note":null}},
    {"id":"evt_11","delivery_id":"dlv_1","type":"delivery.approval_restored","at":"2026-10-09T15:18:26.216Z","data":{"version_id":"ver_4","kind":"video"}}
  ]
}
```

## Testes

- `test/domain.test.ts`: regra pura (peças exigidas vindas da campanha, motivo de cada pendência, versão atual, status derivado, limites do segundo do comentário).
- `test/api.test.ts`: os mesmos cenários pela API, com relógio fixo: aprovar com peça pendente falha listando o que falta; campanha só de vídeo não exige roteiro; versão nova substitui a anterior; versão nova numa entrega aprovada revoga, registra o evento e só volta quando aprovada; comentário fica na versão em que foi feito.

## O que ficou de fora

- Persistência real: só memória. A interface `Repository` existe para trocar por `node:sqlite` ou Postgres sem mexer na regra.
- Autenticação e papéis (quem é marca, quem é criador). Hoje qualquer chamada pode aprovar.
- Upload de verdade, validação de URL e leitura da duração a partir do arquivo (a duração é informada por quem envia).
- Pagamento em si: a API só expõe `payable`. Com mais tempo, publicaria um evento quando `payable` muda, para o financeiro reagir, e trataria concorrência (duas decisões ao mesmo tempo na mesma peça) com versão otimista no repositório.
- Prazo da campanha e limite de rodadas de ajuste.

## Uso de IA

Implementação, testes e README escritos com Claude Code (IA da Anthropic) a partir do enunciado. Coordenei o trabalho junto com a IA: pedi que cada entrega fosse revisada item a item contra as seções O que fazer, Entrega e Como avaliamos do enunciado, e acompanhei as correções que saíram dessa revisão. Nessa revisão, os agentes de auditoria não acharam falha de regra. O que eu revisei: revisei a decisão de a entrega voltar a aprovada sozinha quando a versão nova é aprovada, que segue a letra do enunciado ("até a nova versão ser aprovada"). Conferi os testes de aprovação com peça obrigatória pendente, de campanha só de vídeo sem roteiro e de versão nova que desfaz a aprovação. Os 26 testes e o typecheck passam.
