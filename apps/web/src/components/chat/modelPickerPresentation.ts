export function shouldUseFullScreenModelPicker(input: {
  readonly isPhonePortrait: boolean;
}): boolean {
  return input.isPhonePortrait;
}
