"use strict";

/**
 * Read the documentation (https://strapi.io/documentation/v3.x/concepts/controllers.html#core-controllers)
 * to customize this controller
 */

const { sanitizeEntity } = require("strapi-utils");
const GUEST_ID = "6273d61c526f891461a89088";
const stripe = require("stripe")(process.env.STRIPE_SK);

const sanitizeUser = (user) =>
  sanitizeEntity(user, {
    model: strapi.query("user", "users-permissions").model,
  });

module.exports = {
  async process(ctx) {
    const {
      items,
      total,
      shippingOption,
      idempotencyKey,
      storedIntent,
      email,
      savedCard,
    } = ctx.request.body;

    let serverTotal = 0;
    let unavailable = [];

    await Promise.all(
      items.map(async (clientItem) => {
        const serverItem = await strapi.services.variant.findOne({
          id: clientItem.variant.id,
        });

        if (serverItem.qty < clientItem.qty) {
          unavailable.push({ id: serverItem.id, qty: serverItem.qty });
        }

        serverTotal += serverItem.price * clientItem.qty;
      })
    );

    //only executed after everything in Promise.all has completed SUCCESSFULLY
    const shippingOptions = [
      { label: "FREE SHIPPING", price: 0 },
      { label: "2-DAY SHIPPING", price: 9.99 },
      { label: "OVERNIGHT SHIPPING", price: 29.99 },
    ];

    const shippingValid = shippingOptions.find(
      (option) =>
        option.label === shippingOption.label &&
        option.price === shippingOption.price
    );

    if (
      shippingValid === undefined ||
      (serverTotal * 1.2 + shippingValid.price).toFixed(2) !== total
    ) {
      ctx.send({ error: "Invalid Cart" }, 400);
    } else if (unavailable.length > 0) {
      ctx.send({ unavailable }, 409);
    } else {
      if (storedIntent) {
        const update = await stripe.paymentIntents.update(
          storedIntent,
          {
            //stripe uses cents so we need to multiplicate by 100
            amount: total * 100,
          },
          { idempotencyKey }
        );

        ctx.send({ client_secret: update.client_secret, intentID: update.id });
      } else {
        let saved;

        if (savedCard) {
          const stripeMethods = await stripe.paymentMethods.list({
            customer: ctx.state.user.stripeID,
            type: "card",
          });

          saved = stripeMethods.data.find(
            (method) => method.card.last4 === savedCard
          );
        }

        const intent = await stripe.paymentIntents.create(
          {
            amount: total * 100,
            currency: "usd",
            customer: ctx.state.user ? ctx.state.user.stripeID : undefined,
            receipt_email: email,
            payment_method: saved ? saved.id : undefined,
          },
          { idempotencyKey }
        );

        ctx.send({ client_secret: intent.client_secret, intentID: intent.id });
      }
    }
  },

  async finalize(ctx) {
    const {
      shippingAddress,
      billingAddress,
      shippingInfo,
      billingInfo,
      shippingOption,
      subtotal,
      tax,
      total,
      items,
      transaction,
      cardSlot,
      saveCard,
      paymentMethod,
    } = ctx.request.body;

    let orderCustomer;

    if (ctx.state.user) {
      orderCustomer = ctx.state.user.id;
    } else {
      orderCustomer = GUEST_ID;
    }

    await Promise.all(
      items.map(async (clientItem) => {
        const serverItem = await strapi.services.variant.findOne({
          id: clientItem.variant.id,
        });
        await strapi.services.variant.update(
          { id: clientItem.variant.id },
          { qty: serverItem.qty - clientItem.qty }
        );
      })
    );

    if (saveCard && ctx.state.user) {
      let newMethods = [...ctx.state.user.paymentMethods];

      newMethods[cardSlot] = paymentMethod;

      await strapi.plugins["users-permissions"].services.user.edit(
        { id: orderCustomer },
        { paymentMethods: newMethods }
      );
    }

    let order = await strapi.services.order.create({
      shippingAddress,
      billingAddress,
      shippingInfo,
      billingInfo,
      shippingOption,
      subtotal,
      tax,
      total,
      items,
      transaction,
      paymentMethod,
      user: orderCustomer,
    });

    order = sanitizeEntity(order, { model: strapi.models.order });

    const confirmation = await strapi.services.order.confirmationEmail(order);

    await strapi.plugins["email"].services.email.send({
      to: order.billingInfo.email,
      subject: "VAR-X Order Confirmation",
      html: confirmation,
    });

    if (order.user.username === "Guest") {
      order.user = { username: "Guest" };
    }

    ctx.send({ order }, 200);
  },

  async removeCard(ctx) {
    const { card } = ctx.request.body;
    const { stripeID } = ctx.state.user;

    const stripeMethods = await stripe.paymentMethods.list({
      customer: stripeID,
      type: "card",
    });

    const stripeCard = stripeMethods.data.find(
      (method) => method.card.last4 === card
    );

    await stripe.paymentMethods.detach(stripeCard.id);

    let newMethods = [...ctx.state.user.paymentMethods];

    const cardSlot = newMethods.findIndex((method) => method.last4 === card);

    newMethods[cardSlot] = { brand: "", last4: "" };

    const newUser = await strapi.plugins[
      "users-permissions"
    ].services.user.edit(
      { id: ctx.state.user.id },
      { paymentMethods: newMethods }
    );

    ctx.send({ user: sanitizeUser(newUser) }, 200);
  },
};
