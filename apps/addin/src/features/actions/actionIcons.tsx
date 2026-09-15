import {
  Alert20Regular,
  Archive20Regular,
  ArrowReply20Regular,
  Attach20Regular,
  AttachArrowRight20Regular,
  DocumentArrowRight20Regular,
  Flag20Regular,
  FolderArrowRight20Regular,
  Mail20Regular,
  Megaphone20Regular,
  PersonQuestionMark20Regular,
  ShieldCheckmark20Regular,
  ShieldError20Regular,
  Tag20Regular,
  TaskListSquareLtr20Regular,
  Wrench20Regular,
  MailMultiple20Regular,
} from "@fluentui/react-icons";
import type { ActionType, ProposedAction } from "@oao/shared";
import type { ReactElement } from "react";

export function actionIcon(type: ActionType | "detect_attachment" | "save_attachment"): ReactElement {
  switch (type) {
    case "draft_reply":
      return <ArrowReply20Regular />;
    case "create_reminder":
      return <Alert20Regular />;
    case "create_task":
      return <TaskListSquareLtr20Regular />;
    case "categorize":
    case "classify_email":
      return <Tag20Regular />;
    case "archive":
      return <Archive20Regular />;
    case "move_to_folder":
      return <FolderArrowRight20Regular />;
    case "flag":
      return <Flag20Regular />;
    case "apply_label":
      return <ShieldCheckmark20Regular />;
    case "notify":
      return <Megaphone20Regular />;
    case "request_document":
      return <DocumentArrowRight20Regular />;
    case "escalate_compliance":
      return <ShieldError20Regular />;
    case "remove_attachment":
      return <AttachArrowRight20Regular />;
    case "request_approval":
      return <PersonQuestionMark20Regular />;
    case "detect_attachment":
      return <Attach20Regular />;
    case "save_attachment":
      return <FolderArrowRight20Regular />;
    default:
      return <Wrench20Regular />;
  }
}

export function sourceIcon(kind: ProposedAction["source"]["kind"]): ReactElement {
  switch (kind) {
    case "email":
      return <Mail20Regular />;
    case "attachment":
      return <Attach20Regular />;
    case "thread":
      return <MailMultiple20Regular />;
    default:
      return <Wrench20Regular />;
  }
}
