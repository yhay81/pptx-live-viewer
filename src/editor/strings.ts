import * as vscode from "vscode";
import type { ViewerStrings } from "../shared/protocol";

/**
 * Text shown inside the webview. It is translated here because only the extension host has the
 * localization bundle; templates keep their `{0}` placeholders for the webview to fill in.
 */
export function viewerStrings(): ViewerStrings {
  return {
    loading: vscode.l10n.t("Loading presentation…"),
    toolbar: vscode.l10n.t("Viewer toolbar"),
    thumbnails: vscode.l10n.t("Thumbnails"),
    toggleThumbnails: vscode.l10n.t("Toggle thumbnails"),
    previousSlide: vscode.l10n.t("Previous slide"),
    nextSlide: vscode.l10n.t("Next slide"),
    slideNumber: vscode.l10n.t("Slide number"),
    slideLabel: vscode.l10n.t("Slide {0}"),
    hiddenSlide: vscode.l10n.t("Hidden slide"),
    zoom: vscode.l10n.t("Zoom"),
    zoomIn: vscode.l10n.t("Zoom in"),
    zoomOut: vscode.l10n.t("Zoom out"),
    zoomFit: vscode.l10n.t("Fit slide"),
    zoomWidth: vscode.l10n.t("Fit width"),
    find: vscode.l10n.t("Find"),
    findPlaceholder: vscode.l10n.t("Find in slides"),
    findPrevious: vscode.l10n.t("Previous match"),
    findNext: vscode.l10n.t("Next match"),
    findClose: vscode.l10n.t("Close"),
    findMatchCase: vscode.l10n.t("Match case"),
    findWholeWord: vscode.l10n.t("Match whole word"),
    findRegex: vscode.l10n.t("Use regular expression"),
    findNoResults: vscode.l10n.t("No results"),
    findCount: vscode.l10n.t("{0} of {1}"),
    findInvalidRegex: vscode.l10n.t("Invalid regular expression"),
    notes: vscode.l10n.t("Speaker notes"),
    toggleNotes: vscode.l10n.t("Toggle speaker notes"),
    noNotes: vscode.l10n.t("This slide has no notes."),
    resizeNotes: vscode.l10n.t("Resize the notes panel"),
    emptyDeck: vscode.l10n.t("This presentation has no slides."),
    errorTitle: vscode.l10n.t("Unable to open this presentation"),
    errorEmpty: vscode.l10n.t("The file is empty."),
    errorEncrypted: vscode.l10n.t(
      "The file is password-protected or in the legacy .ppt format. Only unencrypted .pptx files can be shown.",
    ),
    errorNotPptx: vscode.l10n.t("The file is not a valid PowerPoint (.pptx) file."),
    errorTooLarge: vscode.l10n.t("The file is too large to open in the viewer."),
    reloadFailed: vscode.l10n.t("The file could not be reloaded. Showing the previous version."),
    retry: vscode.l10n.t("Retry"),
    dismiss: vscode.l10n.t("Dismiss"),
    renderProblems: vscode.l10n.t("{0} element(s) could not be rendered. See the PPTX Live Viewer output for details."),
  };
}
