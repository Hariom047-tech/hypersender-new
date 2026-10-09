/** OpenAPI JSON schemas for the public WhatsApp gateway contract (also used in docs/webhook-events.md). */
export const ERROR_SCHEMA = {
  type: 'object',
  properties: { error: { type: 'object', properties: { code: { type: 'string', example: 'WHATSAPP_INSTANCE_NOT_FOUND' }, message: { type: 'string' } } } },
};

export const INSTANCE_STATUS_ENUM = ['CREATED', 'WAITING_FOR_QR', 'PAIRING', 'CONNECTED', 'RECONNECTING', 'DISCONNECTED', 'LOGGED_OUT', 'ERROR', 'SUSPENDED'];

export const INSTANCE_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' }, businessId: { type: 'string', format: 'uuid' }, name: { type: 'string' },
    description: { type: 'string', nullable: true }, provider: { type: 'string', example: 'BAILEYS' },
    status: { type: 'string', enum: INSTANCE_STATUS_ENUM }, phoneNumber: { type: 'string', nullable: true, example: '+919812345678' },
    displayName: { type: 'string', nullable: true }, connectedAt: { type: 'string', format: 'date-time', nullable: true },
    lastSeenAt: { type: 'string', format: 'date-time', nullable: true }, createdAt: { type: 'string', format: 'date-time' },
  },
};

export const STATUS_SCHEMA = {
  type: 'object',
  properties: {
    instanceId: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: INSTANCE_STATUS_ENUM },
    phoneNumber: { type: 'string', nullable: true }, displayName: { type: 'string', nullable: true },
    connectedAt: { type: 'string', format: 'date-time', nullable: true }, lastSeenAt: { type: 'string', format: 'date-time', nullable: true },
    qrAvailable: { type: 'boolean' },
    worker: { type: 'object', properties: { assigned: { type: 'boolean' }, healthy: { type: 'boolean' } } },
  },
};

export const COMMAND_ACCEPTED_SCHEMA = {
  type: 'object',
  properties: { instanceId: { type: 'string', format: 'uuid' }, command: { type: 'string', enum: ['CONNECT', 'RESTART', 'DISCONNECT', 'LOGOUT', 'DELETE'] },
                accepted: { type: 'boolean' }, status: { type: 'string', enum: INSTANCE_STATUS_ENUM, description: 'status at request time' } },
};

export const QUEUED_SCHEMA = {
  type: 'object',
  properties: { messageId: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: ['QUEUED'] }, duplicate: { type: 'boolean' } },
};

export const MESSAGE_BODY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' }, providerMessageId: { type: 'string', nullable: true },
    direction: { type: 'string', enum: ['INBOUND', 'OUTBOUND'] },
    origin: { type: 'string', enum: ['CONTACT', 'API', 'DASHBOARD', 'AI', 'LINKED_DEVICE', 'SYSTEM'], nullable: true },
    fromMe: { type: 'boolean' }, from: { type: 'string', nullable: true }, to: { type: 'string', nullable: true },
    type: { type: 'string', enum: ['TEXT', 'IMAGE', 'VIDEO', 'AUDIO', 'VOICE', 'DOCUMENT', 'LOCATION', 'CONTACT', 'REACTION', 'POLL', 'STICKER', 'UNKNOWN'] },
    text: { type: 'string', nullable: true },
    status: { type: 'string', enum: ['RECEIVED', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'REVOKED'] },
    timestamp: { type: 'string', format: 'date-time' }, replyToProviderMessageId: { type: 'string', nullable: true },
    attachments: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, mediaType: { type: 'string' }, mimeType: { type: 'string' },
      fileName: { type: 'string', nullable: true }, fileSize: { type: 'integer', nullable: true }, status: { type: 'string' } } } },
    errorCode: { type: 'string', nullable: true },
  },
};

export const MESSAGE_VIEW_SCHEMA = {
  type: 'object',
  properties: {
    businessId: { type: 'string', format: 'uuid' },
    instance: { type: 'object', properties: { id: { type: 'string' }, phone: { type: 'string', nullable: true } } },
    conversation: { type: 'object', properties: { id: { type: 'string' } } },
    contact: { type: 'object', properties: { id: { type: 'string' }, phone: { type: 'string', nullable: true }, name: { type: 'string', nullable: true } } },
    message: MESSAGE_BODY_SCHEMA,
  },
};

/** Webhook envelope (documented as a component; delivered by POST to subscriber URLs). */
export const WEBHOOK_EVENT_SCHEMA = {
  type: 'object',
  required: ['id', 'type', 'createdAt', 'organizationId'],
  properties: {
    id: { type: 'string', example: 'evt_01a0e2cb-8d1d-7887-8f50-2eac28fbb2e1' },
    type: { type: 'string', enum: ['INSTANCE_CONNECTED', 'INSTANCE_DISCONNECTED', 'INSTANCE_STATUS_CHANGED', 'MESSAGE_RECEIVED', 'MESSAGE_SENT',
      'MESSAGE_DELIVERED', 'MESSAGE_READ', 'MESSAGE_FAILED', 'MESSAGE_REVOKED', 'MESSAGE_REACTION'] },
    createdAt: { type: 'string', format: 'date-time' },
    organizationId: { type: 'string', format: 'uuid' },
    businessId: { type: 'string', format: 'uuid', nullable: true },
    instance: { type: 'object', properties: { id: { type: 'string' }, phone: { type: 'string', nullable: true }, status: { type: 'string' },
      previousStatus: { type: 'string' }, reason: { type: 'string', nullable: true } } },
    conversation: { type: 'object', properties: { id: { type: 'string' } } },
    contact: { type: 'object', properties: { id: { type: 'string' }, phone: { type: 'string', nullable: true }, name: { type: 'string', nullable: true } } },
    message: MESSAGE_BODY_SCHEMA,
  },
};
