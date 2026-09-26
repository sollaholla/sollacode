# Referenced files in results

The web and desktop chat results include a **Referenced files** section. It gathers explicit file links in assistant messages and structured file-read tool results for that turn. This works with every provider, including turns in workspaces without Git checkpoints.

Entries appear only after the thread's environment confirms they are files on disk. Missing paths, directories, web URLs, and text that merely looks like a filename are excluded. The count and Show all control include only confirmed files; a turn with no confirmed references has no reference card. Checks are batched and briefly cached per environment. A file removed after verification can still produce a viewer fallback when opened.

Tap an image, video, or audio chip for a preview. Media loads when opened and does not autoplay. Other file chips open the existing file viewer. Audio files opened in the viewer play in an inline player on web and desktop; the native mobile app hands them to the system player instead. The list initially shows six references; **Show all** expands it. Missing files and unsupported browser codecs show a fallback instead of an empty player.

When a turn has Git checkpoint changes, references appear in the same card as the changed files. Without Git changes, references have their own card. The list describes referenced files, not a claim that every referenced file was changed. Existing historical turns also gain references when their messages or structured tool results contain recognizable paths.

The native mobile client retains its existing file-link presentation; this card is part of the shared web UI, including mobile Safari.

On phones, media opens in a full-screen viewer with a safe-area-aware header, a large close button, a centered image or player, and a separate Open original control. Images fit without cropping; audio/video do not autoplay. Desktop retains a bounded modal.
