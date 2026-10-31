/** Released Organization/Team API facade. New engine consumers import ./access/index explicitly. */
export * from "./access/index";
export {
  LegacyAccessService as AccessService,
  registerPrincipal,
  personalSpace,
} from "./access/legacy-adapter";
