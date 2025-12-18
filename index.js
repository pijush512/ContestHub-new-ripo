const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const stripe = require("stripe")(process.env.STRIP_SECRET);

const port = process.env.PORT || 3000;

const admin = require("firebase-admin");

const serviceAccount = require("./contesthub-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Middleware
app.use(express.json());
app.use(cors());

const veriffyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("decoded in the token", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "unauthorized assess" });
  }
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.5fdvbil.mongodb.net/?appName=Cluster0`;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    const db = client.db("contest_hub_db");
    const contestCollection = db.collection("contest");
    const usersCollection = db.collection("users");
    const participateCollection = db.collection("participations");
    const submissionsCollection = db.collection("submissions");
    const paymentHistoryCollection = db.collection("paymentHistoryCollection");

    const duplicates = await paymentHistoryCollection
      .aggregate([
        { $group: { _id: "$transactionId", count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
      ])
      .toArray();

    console.log(duplicates);

    await paymentHistoryCollection
      .aggregate([
        {
          $group: {
            _id: "$transactionId",
            ids: { $push: "$_id" },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ])
      .forEach(async (doc) => {
        // Keep the first document, delete the rest
        doc.ids.shift(); // remove first
        await paymentHistoryCollection.deleteMany({ _id: { $in: doc.ids } });
      });

    await paymentHistoryCollection.createIndex(
      { transactionId: 1 },
      { unique: true }
    );
    console.log("Unique index created for transactionId");

    // !! ROLE VERIFICATION MIDDLEWARES

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "admin") {
        return res
          .status(403)
          .send({ message: "Forbidden access: Admin only" });
      }
      next();
    };

    const verifyCreator = async (req, res, next) => {
      const email = req.decoded_email;
      const user = await usersCollection.findOne({ email });
      const isCreator = user?.role === "creator" || user?.role === "admin";
      if (!isCreator) {
        return res
          .status(403)
          .send({ message: "Forbidden access: Creator only" });
      }
      next();
    };
    // !! End !! ROLE VERIFICATION MIDDLEWARES

    // users related apis
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();

      const email = user.email;

      const userExists = await usersCollection.findOne({ email });

      if (userExists) {
        return res.send({ message: "user exists" });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // GET all users // !! Use role
    app.get("/users/role/:email", veriffyFBToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded_email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const query = { email: email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role });
    });

    // !! Use role Admin
    app.get("/users", veriffyFBToken, verifyAdmin, async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        res.send(users);
      } catch (err) {
        console.error(err);
        res.status(500).send({ error: "Failed to fetch users" });
      }
    });

    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ email });
      res.send(result);
    });

    app.patch("/users/:email", async (req, res) => {
      const email = req.params.email;

      if (req.user.email !== email) {
        return res
          .status(403)
          .send({ message: "Forbidden access: Cannot edit other profiles" });
      }

      const result = await usersCollection.updateOne(
        { email: email },
        { $set: req.body }
      );
      if (result.matchedCount === 0)
        return res.status(404).send("User not found");
      res.send("Profile updated!");
    });

    // Role wise user update // !! Use role
    app.patch(
      "/users/role/:email",
      veriffyFBToken,
      verifyAdmin,
      async (req, res) => {
        const email = req.params.email;
        const { role } = req.body;
        const result = await usersCollection.updateOne(
          { email: email },
          { $set: { role: role } }
        );
        res.send(result);
      }
    );

    // Contest Api
    app.get("/contest", async (req, res) => {
      const result = await contestCollection.find().toArray();
      res.send(result);
    });

    // GET contests by creator email
    app.get("/contest/creator/:email", async (req, res) => {
      const { email } = req.params;
      const result = await contestCollection
        .find({ creatorEmail: email })
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    // Popular contests show in ui
    app.get("/contests/popular", async (req, res) => {
      const result = await contestCollection
        .find({ status: "approved" })
        .sort({ participantsCount: -1 })
        .limit(6)
        .toArray();

      res.send(result);
    });

    app.get("/contests", async (req, res) => {
      try {
        const { type } = req.query;
        const filter = { status: "approved" };

        if (type && type !== "all") {
          const typeMap = {
            "Image Design": "image-design",
            "Article Writing": "article-writing",
            "Business Ideas": "business-idea",
            "Gaming Reviews": "gaming-review",
          };
          filter.type = typeMap[type];
        }

        const contests = await contestCollection
          .find(filter)
          .sort({ createdAt: -1 })
          .toArray();

        res.send(contests);
      } catch (err) {
        console.error(err);
        res.status(500).send({ error: "Failed to fetch contests" });
      }
    });

    // GET single contest by id
    app.get("/contest/:id", async (req, res) => {
      const id = req.params.id;
      try {
        const contest = await contestCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!contest)
          return res.status(404).send({ message: "Contest not found" });
        res.send(contest);
      } catch (err) {
        console.error(err);
        res.status(500).send({ error: "Failed to fetch contest" });
      }
    });

    // !! Use role
    app.post("/contest", veriffyFBToken, verifyCreator, async (req, res) => {
      const contest = {
        ...req.body,
        status: "pending",
        participantsCount: 0,
        createdAt: new Date(),
      };
      const result = await contestCollection.insertOne(contest);
      res.send(result);
    });

    // Update contest (approve/reject)
    app.patch("/contest/:id", async (req, res) => {
      const id = req.params.id;
      const updateData = req.body;

      try {
        const result = await contestCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        );
        if (result.matchedCount === 0)
          return res.status(404).send({ message: "Contest not found" });

        res.send({ message: "Contest updated successfully" });
      } catch (err) {
        console.error(err);
        res.status(500).send({ error: "Failed to update contest" });
      }
    });

    // update winning contest
    app.patch("/contest/declare-winner/:id", async (req, res) => {
      const id = req.params.id;
      const { winnerEmail, winnerName, winnerPhoto } = req.body;

      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          winnerEmail,
          winnerName,
          winnerPhoto,
          status: "completed",
          winDate: new Date(),
        },
      };
      const result = await contestCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

  
    app.get("/contest/won/:email", async (req, res) => {
      const email = req.params.email;
      const query = { winnerEmail: email };
      const result = await contestCollection.find(query).toArray();
      res.send(result);
    });

    // !! Use role
    app.delete(
      "/contest/:id",
      veriffyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await contestCollection.deleteOne(query);
        res.send(result);
      }
    );

    app.get("/participations", async (req, res) => {
      const { contestId, userEmail } = req.query;

      const existing = await participateCollection.findOne({
        contestId,
        userEmail,
      });

      res.send({
        alreadyRegistered: !!existing,
      });
    });

    // GET participated contests by user email
    app.get("/contest/participated/:email", async (req, res) => {
      const { email } = req.params;

      try {
        // User er sob participation fetch
        const participations = await participateCollection
          .find({ userEmail: email })
          .toArray();

        //Contest er info add koroa
        const contests = await Promise.all(
          participations.map(async (p) => {
            const contest = await contestCollection.findOne({
              _id: new ObjectId(p.contestId),
            });
            return {
              ...contest,
              registeredAt: p.registeredAt,
              // isWinner: contest.winnerEmail === email
            };
          })
        );

        res.send(contests);
      } catch (err) {
        console.error(err);
        res
          .status(500)
          .send({ message: "Failed to fetch participated contests" });
      }
    });

    app.post("/participations", async (req, res) => {
      try {
        const { contestId, userEmail, registeredAt } = req.body;

        // 1️⃣ Payload validation
        if (!contestId || !userEmail) {
          console.log("Missing contestId or userEmail:", req.body);
          return res
            .status(400)
            .send({ message: "contestId & userEmail are required" });
        }

        // 2️⃣ Duplicate check
        const existing = await participateCollection.findOne({
          contestId,
          userEmail,
        });
        if (existing) {
          console.log("Already registered:", { contestId, userEmail });
          return res.status(400).send({ message: "Already registered" });
        }

        // 3️⃣ Insert participation
        const participationData = {
          contestId,
          userEmail,
          registeredAt: registeredAt || new Date(),
        };

        const result = await participateCollection.insertOne(participationData);
        console.log("Participation Insert Result:", result);

        // 4️⃣ Send response
        res.send({
          success: true,
          message: "Successfully registered",
          insertedId: result.insertedId,
        });
      } catch (err) {
        console.error("Participations insert error:", err);
        res.status(500).send({ success: false, message: "Server error" });
      }
    });

    // Payment related API
    // !! Use role
    app.get("/payments", veriffyFBToken, async (req, res) => {
      const email = req.query.email;
      const query = {};
      if (email) {
        query.userEmail = email;
        // check email address
        if (email !== req.decoded_email) {
          return res.status(403).send({ message: "forbidden access " });
        }
      }

      const cursor = paymentHistoryCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.price) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.contestName,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.userEmail,
        mode: "payment",
        metadata: {
          contestId: paymentInfo.contestId,
          contestName: paymentInfo.contestName,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });

      // res.redirect(303, session.url);
      console.log(session);
      res.send({ url: session.url });
    });

    app.patch("/payment-success", async (req, res) => {
      try {
        const sessionId = req.query.session_id;
        const session = await stripe.checkout.sessions.retrieve(sessionId);

        if (session.payment_status !== "paid") {
          return res.send({
            success: false,
            message: "Payment not completed yet",
            status: session.payment_status,
          });
        }

        const contestId = session.metadata.contestId;
        const userEmail = session.customer_email;
        const transactionId = session.payment_intent;

        const trackingId =
          "TRK-" + Math.random().toString(36).substring(2, 10).toUpperCase();
        const isAllreadyExist = await paymentHistoryCollection.findOne({
          transactionId,
        });

        if (!isAllreadyExist) {
          await paymentHistoryCollection.insertOne({
            contestId,
            contestName: session.metadata.contestName,
            userEmail,
            amount: session.amount_total / 100,
            currency: session.currency,
            trackingId,
            transactionId,
            registeredAt: new Date(session.created * 1000),
          });

          await participateCollection.insertOne({
            contestId: contestId,
            userEmail: userEmail,
            transactionId: transactionId,
            registeredAt: new Date(),
          });
        }

        await contestCollection.updateOne(
          { _id: new ObjectId(contestId) },
          { $inc: { participantsCount: 1 } }
        );

        res.send({
          success: true,
          message: "Payment successful & registered",
          paymentInfo: {
            contestId,
            contestName: session.metadata.contestName,
            amount: session.amount_total / 100,
            currency: session.currency,
            trackingId,
            transactionId,
          },
        });
      } catch (error) {
        if (error.code === 11000) {
          return res.send({
            success: true,
            message: "Payment already processed",
            duplicate: true,
          });
        }

        console.error(error);
        res.status(500).send({
          success: false,
          message: "Server error",
        });
      }
    });

    // submissionsCollection related api
    app.post("/submissions", async (req, res) => {
      try {
        const { contestId, userEmail, taskLink, submittedAt } = req.body;

        const isRegistered = await participateCollection.findOne({
          contestId,
          userEmail,
        });

        if (!isRegistered) {
          return res.status(403).send({
            success: false,
            message: "You must be registered/paid to submit a task.",
          });
        }

        const existing = await submissionsCollection.findOne({
          contestId,
          userEmail,
        });

        if (existing) {
          return res.send({
            success: false,
            message: "You have already submitted this contest",
          });
        }

        const submissionDoc = {
          contestId,
          userEmail,
          taskLink,
          submittedAt: submittedAt || new Date(),
          status: "pending",
        };

        const result = await submissionsCollection.insertOne(submissionDoc);

        res.send({
          success: true,
          message: "Task submitted successfully",
          result,
        });
      } catch (err) {
        console.error(err);
        res.status(500).send({ success: false, message: "Server error" });
      }
    });

    // see submission
    //   try {
    //     const { contestId, userEmail, taskLink, submittedAt } = req.body;

    //     // 1️⃣ Check duplicate submission
    //     const existing = await submissionsCollection.findOne({
    //       contestId,
    //       userEmail,
    //     });
    //     if (existing) {
    //       return res.send({
    //         success: false,
    //         message: "You already submitted this contest",
    //       });
    //     }

    //     // 2️⃣ Insert submission
    //     const result = await submissionsCollection.insertOne({
    //       contestId,
    //       userEmail,
    //       taskLink,
    //       submittedAt: submittedAt || new Date(),
    //     });

    //     res.send({
    //       success: true,
    //       message: "Task submitted successfully",
    //       result,
    //     });
    //   } catch (err) {
    //     console.error(err);
    //     res.status(500).send({ success: false, message: "Server error" });
    //   }
    // });

    // Show creator dashbord api
    app.get("/creator/submissions/:contestId", async (req, res) => {
      const { contestId } = req.params;
      const query = { contestId: contestId };
      const submissions = await submissionsCollection.find(query).toArray();
      res.send(submissions);
    });

    // ! Use Role
    // ক্রিয়েটরের সব কন্টেস্টের সব সাবমিশন একসাথে পাওয়ার API
    app.get(
      "/creator/all-submissions/:email",
      veriffyFBToken,
      async (req, res) => {
        const email = req.params.email;

        // ১. প্রথমে ক্রিয়েটরের সব কন্টেস্ট আইডি খুঁজে বের করা
        const creatorContests = await contestCollection
          .find({ creatorEmail: email })
          .toArray();
        const contestIds = creatorContests.map((c) => c._id.toString());

        // ২. ওই আইডিগুলো ব্যবহার করে সব সাবমিশন খুঁজে বের করা
        const submissions = await submissionsCollection
          .find({
            contestId: { $in: contestIds },
          })
          .toArray();

        res.send(submissions);
      }
    );

    // leaderboard
    app.get("/leaderboard", async (req, res) => {
      const result = await usersCollection
        .find({ winCount: { $gt: 0 } }) 
        .sort({ winCount: -1 })
        .limit(10)
        .toArray();
      res.send(result);
    });
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("ContestHub is running");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
