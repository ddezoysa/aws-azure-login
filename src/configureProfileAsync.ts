import inquirer from "inquirer";
import { awsConfig } from "./awsConfig";

export async function configureProfileAsync(
  profileName: string
): Promise<void> {
  console.log(`Configuring profile '${profileName}'`);

  const profile = await awsConfig.getProfileConfigAsync(profileName);
  const answers = await inquirer.prompt([
    {
      name: "tenantId",
      message: "Azure Tenant ID:",
      validate: (input): boolean => !!input,
      default: profile && profile.azure_tenant_id,
    },
    {
      name: "appIdUri",
      message: "Azure App ID URI:",
      validate: (input): boolean => !!input,
      default: profile && profile.azure_app_id_uri,
    },
    {
      name: "username",
      message: "Default Username:",
      default: profile && profile.azure_default_username,
    },
    {
      name: "rememberMe",
      message:
        "Stay logged in: skip authentication while refreshing aws credentials (true|false)",
      default:
        (profile &&
          profile.azure_default_remember_me &&
          profile.azure_default_remember_me.toString()) ||
        "false",
      validate: (input): boolean | string => {
        if (input === "true" || input === "false") return true;
        return "Remember me must be either true or false";
      },
    },
    {
      name: "defaultRoleArn",
      message: "Default Role ARN (if multiple):",
      default: profile && profile.azure_default_role_arn,
    },
    {
      name: "defaultDurationHours",
      message: "Default Session Duration Hours (up to 12):",
      default: (profile && profile.azure_default_duration_hours) || 1,
      validate: (input): boolean | string => {
        input = Number(input);
        if (input > 0 && input <= 12) return true;
        return "Duration hours must be between 0 and 12";
      },
    },
  ]);

  await awsConfig.setProfileConfigValuesAsync(profileName, {
    azure_tenant_id: answers.tenantId,
    azure_app_id_uri: answers.appIdUri,
    azure_default_username: answers.username,
    azure_default_role_arn: answers.defaultRoleArn,
    azure_default_duration_hours: answers.defaultDurationHours,
    azure_default_remember_me: answers.rememberMe,
  });

  console.log("Profile saved.");
}
