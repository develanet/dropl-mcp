import type { FeedbackMessageSummary, FeedbackRequestDetail, FeedbackRequestSummary, PublicFeedbackListResponse } from "@dropl/shared";
import { pathSegment } from "./api-client.js";

export const feedbackPath = (requestId: string) => `/v1/feedback/${pathSegment(requestId)}`;

/** Shared by the tool descriptions and the server instructions, so the workflow reads the same everywhere. */
export const FEEDBACK_TOOL_GUIDANCE = {
  textChanges:
    "Text changes (type text_change) give the current and the exact new wording; they can usually be applied directly in the code (search the project for currentText).",
  ambiguous: "If a request is ambiguous, reply_to_feedback asking the client to clarify instead of guessing.",
  markDone: "After fixing a request, mark it done with update_feedback_status and a short note saying what changed (the client gets it by email).",
} as const;

function summaryView(request: FeedbackRequestSummary) {
  return {
    id: request.id,
    number: request.number,
    site: request.site,
    type: request.type,
    imageAction: request.imageAction,
    status: request.status,
    message: request.message,
    currentText: request.currentText,
    requestedText: request.requestedText,
    pageUrl: request.pageUrl,
    pageTitle: request.pageTitle,
    requester: request.requester.name,
    deviceType: request.deviceType,
    hasScreenshot: request.screenshot !== null,
    replyCount: request.replyCount,
    createdAt: request.createdAt,
  };
}

export function feedbackListResult(response: PublicFeedbackListResponse, offset: number) {
  const nextOffset = offset + response.requests.length < response.total ? offset + response.requests.length : null;
  return { requests: response.requests.map(summaryView), total: response.total, nextOffset };
}

function messageView(message: FeedbackMessageSummary) {
  return {
    kind: message.kind,
    author: message.author.name,
    isTeam: message.author.isTeam,
    body: message.body,
    ...(message.kind === "status" && { statusFrom: message.statusFrom, statusTo: message.statusTo }),
    attachments: message.attachments.map((attachment) => ({ fileName: attachment.fileName, url: attachment.largeUrl })),
    createdAt: message.createdAt,
  };
}

/** Everything an agent needs to find the spot in the code: page, element selector and text, device, photos, and the thread. */
export function feedbackDetailResult(request: FeedbackRequestDetail) {
  const attachments = [...(request.screenshot ? [request.screenshot] : []), ...request.attachments.filter((attachment) => attachment.id !== request.screenshot?.id)];
  return {
    ...summaryView(request),
    pagePath: request.pagePath,
    element: request.element,
    context: request.context,
    attachments: attachments.map((attachment) => ({
      purpose: attachment.purpose,
      status: attachment.status,
      fileName: attachment.fileName,
      url: attachment.largeUrl,
      width: attachment.width,
      height: attachment.height,
    })),
    resolutionNote: request.resolutionNote,
    allowedStatuses: request.allowedStatuses,
    thread: request.messages.map(messageView),
  };
}
