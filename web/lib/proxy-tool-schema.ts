// Public tool metadata only. Never import server credentials into this module.
const stringMap = { type: 'object', additionalProperties: { type: 'string' } };
export const PROXY_REQUEST_SCHEMA = {
  type: 'object',
  properties: {
    url: { type: 'string', enum: ['https://api.finmindtrade.com/api/v4/data', 'https://api.web.finmindtrade.com/v2/user_info'] },
    method: { type: 'string', enum: ['GET'] },
    headers: { ...stringMap, description: 'Use Authorization: Bearer {{alias}} to opt in to the saved FinMind key. Never provide a literal key. Omit that header for anonymous access.' },
    query: { ...stringMap, description: 'Price requests require dataset=TaiwanStockPrice, data_id, start_date, end_date; one stock and at most 31 days. Usage accepts no query.' },
    json: { description: 'Generic request shape; body is currently disallowed for the enabled GET endpoints.' },
    form: { ...stringMap, description: 'Generic request shape; body is currently disallowed for the enabled GET endpoints.' },
  },
  required: ['url', 'method'], additionalProperties: false,
};
