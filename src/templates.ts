/**
 * Invoice template management — save, create, delete, get, list templates.
 */

import type {
  InvoiceTemplate,
  CreateFromTemplateParams,
  SaveTemplateParams,
} from "./types/templates.js";
import type { CreateInvoiceParams } from "./types/index.js";
import { StellarSplitError } from "./errors.js";

export class TemplateNotFoundError extends StellarSplitError {
  readonly templateId: bigint;

  constructor(templateId: bigint) {
    super(
      `Template not found: ${templateId}`,
      "TEMPLATE_NOT_FOUND",
      { templateId }
    );
    this.name = "TemplateNotFoundError";
    this.templateId = templateId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class TemplateAccessDeniedError extends StellarSplitError {
  readonly templateId: bigint;

  constructor(templateId: bigint) {
    super(
      `Not authorized to delete template: ${templateId}`,
      "TEMPLATE_ACCESS_DENIED",
      { templateId }
    );
    this.name = "TemplateAccessDeniedError";
    this.templateId = templateId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const templates = new Map<bigint, InvoiceTemplate>();
let nextTemplateId = BigInt(1);

export async function saveTemplate(
  params: SaveTemplateParams,
  creator: string
): Promise<bigint> {
  const templateId = nextTemplateId++;

  const template: InvoiceTemplate = {
    id: templateId,
    name: params.name,
    params: params.params,
    createdAt: Date.now(),
    creator,
  };

  templates.set(templateId, template);
  return templateId;
}

export async function createFromTemplate(
  params: CreateFromTemplateParams,
  creator: string
): Promise<bigint> {
  const template = templates.get(params.templateId);
  if (!template) {
    throw new TemplateNotFoundError(params.templateId);
  }

  // Merge template params with overrides
  const mergedParams = {
    ...template.params,
    ...(params.overrides || {}),
  };

  // In a real implementation, this would invoke the contract
  // to create an invoice with the merged params and return the invoice ID
  const invoiceId = BigInt(Date.now());
  return invoiceId;
}

export async function deleteTemplate(
  templateId: bigint,
  creator: string
): Promise<void> {
  const template = templates.get(templateId);
  if (!template) {
    throw new TemplateNotFoundError(templateId);
  }

  if (template.creator !== creator) {
    throw new TemplateAccessDeniedError(templateId);
  }

  templates.delete(templateId);
}

export async function getTemplate(templateId: bigint): Promise<InvoiceTemplate> {
  const template = templates.get(templateId);
  if (!template) {
    throw new TemplateNotFoundError(templateId);
  }
  return template;
}

export async function listTemplates(creator: string): Promise<InvoiceTemplate[]> {
  const creatorTemplates: InvoiceTemplate[] = [];

  for (const template of templates.values()) {
    if (template.creator === creator) {
      creatorTemplates.push(template);
    }
  }

  return creatorTemplates.sort((a, b) => b.createdAt - a.createdAt);
}
