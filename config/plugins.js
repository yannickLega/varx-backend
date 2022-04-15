module.exports = ({ env }) => ({
  email: {
    provider: "sendgrid",
    providerOptions: {
      apiKey: env("SENDGRID_API_API"),
    },
    settings: {
      defaultFrom: "necro.files666@gmail.com",
      defaultTo: "necro.files666@gmail.com",
    },
  },
});
