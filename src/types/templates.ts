/**
 * Invoice template types for template-based invoice creation.
 */

import type { CreateInvoiceParams, Recipient } from "./index.js";

export interface InvoiceTemplate {
  id: bigint;
  name: string;
  params: CreateInvoiceParams;
  createdAt: number;
  creator: string;
}

export interface CreateFromTemplateParams {
  templateId: bigint;
  overrides?: Partial<CreateInvoiceParams>;
}

export interface SaveTemplateParams {
  name: string;
  params: CreateInvoiceParams;
}
