const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const setupConnection = require('../config/database.config');
const { generateCustomerId, getCustomerCount } = require('../config/User.counter');
const { mailsending } = require('../config/mailsending.config');
const { uploadOnCloudinary } = require('../config/cloudinary.config');
require('dotenv').config();


exports.createUser = async (req, res) => {
  try {
      const { first_name, last_name, email, pass, phone } = req.body;
      const imagePath = req.file; // Get the uploaded image file

      if (!first_name || !last_name || !email || !pass || !phone) {
          return res.status(400).json({
              message: "All credentials are required"
          });
      }

      const customer_id =await generateCustomerId();
      // console.log(getCustomerCount);

      // Hash the password before storing it
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(pass, salt);

      // Upload the image to Cloudinary if it exists
      let imgUrl = "None";
      if (imagePath) {
          imgUrl = await uploadOnCloudinary(imagePath.path); // Upload and get the URL
      }

      // SQL query to insert data into the 'Customer' table
      const query = `INSERT INTO Customer (customer_id, first_name, last_name, email, password, phone, profile_image) 
                     VALUES (?, ?, ?, ?, ?, ?, ?)`;

      const password = hashedPassword;

      // Wait for the database connection
      const db = await setupConnection();

      // Execute the query using the db connection
      const [result] = await db.execute(query, [customer_id, first_name, last_name, email, password, phone, imgUrl]);
      console.log("The user ", result);

      // Send a success response
      res.status(201).json({ message: 'User created successfully', userId: result.insertId });

  } catch (error) {
      console.error("An error occurred while creating the user", error);
      res.status(500).json({ error: 'Failed to create user' });
  }
};

const createAddress = async () => {
    try {
        const userId = req.user.customer_id;
        const { street, city, state, postal_code, country } = req.body;

        const addressId = `ADDR${Date.now()}`; // Example: "ADDR" followed by the current timestamp

        // SQL query to insert the new address
        const query = `
        INSERT INTO Address (address_id, customer_id, street, city, state, postal_code, country)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
        const db = await setupConnection();
        // Execute the query
        await db.execute(query, [addressId, userId, street, city, state, postal_code, country]);

        // Send a success response
        return res.status(201).json({ message: 'Address created successfully', addressId });
    } catch (error) {
        console.error('Error occurred while creating address:', error);
        return res.status(500).json({ message: 'Error occurred while creating address for the user' });
    }
};


exports.loginUser = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({
                message: "All credentials are required"
            });
        }

        // SQL query to select the user by email
        const query = `SELECT * FROM Customer WHERE email = ?`;

        const db = await setupConnection();
        const [result] = await db.execute(query, [email]);

        if (result.length === 0) {
            return res.status(400).json({
                message: "User not found"
            });
        }

        const user = result[0];

        // Check if the provided password matches the hashed password in the database
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({
                message: "Password does not match"
            });
        }

        // Create a JWT token using the user's customer_id as payload
        const token = await jwt.sign({ customer_id: user.customer_id }, process.env.SECRET_KEY, { expiresIn: '1h' });

        // Set the token in a cookie
        res.cookie('token', token, {
            httpOnly: true
        });

        return res.status(200).json({
            message: "Login successful",
            token: token
        });

    } catch (error) {
        console.error("An error occurred during login", error);
        return res.status(500).json({
            message: "An error occurred during login"
        });
    }
};


// Function to generate a 6-digit OTP
const generateotp = () => {
    return Math.floor(100000 + Math.random() * 900000);  // Generates a random 6-digit integer
};

exports.forgotpassword = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({
                message: "Email is required"
            });
        }

        const query = 'SELECT * FROM Customer WHERE email = ?';
        const db = await setupConnection();

        const [user] = await db.execute(query, [email]);
        if (!user || user.length === 0) {
            return res.status(400).json({
                message: "The user does not exist"
            });
        }

        const otp = generateotp();
        const response = await mailsending(email, otp);


        const otpquery = 'INSERT INTO OTP(otp, CUST_ID, created_at, expires_at, isVerified) VALUES (?, ?, ?, ?, ?)';
        const expires_at = new Date(Date.now() + 10 * 60 * 1000);

        const [result] = await db.execute(otpquery, [otp, user[0].customer_id, new Date(), expires_at, false]);
        if (result.length === 0) {
            return res.status(400).json({
                message: "An error occured in this "
            });
        }
        const token = await jwt.sign({ customer_id: user[0].customer_id }, process.env.SECRET_KEY, { expiresIn: '1h' });
        console.log(token);
        const option = {
            expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
            httpOnly: true,
            secure: true,
            samesite: "none"
        };

        // Set the token in a cookie
        // ankit's 5 minutes wasted here - koi nhi bhai tere liye 5 min kurbaan
        res.cookie("token", token, option);

        return res.status(200).send({ token })

    } catch (error) {
        return res.status(500).json({
            message: "Internal server error ankit",
            error: error.message
        });
    }
};

exports.validateOtp = async (req, res) => {
    try {
        const { otp, newpassword } = req.body;
        const user = req.user;
        if (!otp || !user || !newpassword) {
            return res.status(401).json({
                message: "Some credentials are missing"
            });
        }

        const db = await setupConnection();
        const query = 'SELECT * FROM OTP WHERE CUST_ID = ?';
        const [result] = await db.execute(query, [user.customer_id]);

        if (result.length === 0) {
            return res.status(401).json({
                message: "The user is not verified"
            });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newpassword, salt);
        const newQuery = 'UPDATE Customer SET password = ? WHERE email = ?';
        const [newResult] = await db.execute(newQuery, [hashedPassword, user.email]);

        if (newResult.affectedRows === 0) {
            return res.status(401).json({
                message: "The user's password is not updated"
            });
        }

        return res.status(200).json({
            message: "The user is verified",
            user: user
        });

    } catch (error) {
        return res.status(400).json({
            message: "The user's OTP is not verified and the password is not updated",
            error: error.message
        });
    }
}

exports.getUser = async (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(400).json({
        message: "The middleware is not working"
      });
    }

    // Query to fetch user data from the Customer table
    const userQuery = `
      SELECT customer_id, first_name, last_name, email, phone, profile_image 
      FROM Customer 
      WHERE customer_id = ?
    `;

    // Query to fetch address data from the Address table
    const addressQuery = `
      SELECT street, city, country, state, postal_code 
      FROM Address 
      WHERE customer_id = ?
    `;

    const db = await setupConnection();

    // Execute the query to get user data
    const [userResult] = await db.execute(userQuery, [user.customer_id]);
    if (userResult.length === 0) {
      return res.status(404).json({
        message: "User not found"
      });
    }

    // Execute the query to get address data
    const [addressResult] = await db.execute(addressQuery, [user.customer_id]);

    // Prepare the response object with user data
    const responseData = {
      ...userResult[0],
      address: addressResult[0] || null // Set address as null if no address is found
    };

    // Return the merged user data
    return res.status(200).json({
      user: responseData
    });

  } catch (error) {
    console.error("Error occurred while fetching the user data:", error);
    return res.status(500).json({
      message: "Error occurred while fetching the user data"
    });
  }
};

exports.updateUser = async (req, res) => {
    let db;
    try {
      const user = req.user;
      const { firstName, lastName, email, phone, profileImage, street, city, country, state, postalCode } = req.body;
  
      console.log('Request Body Parameters:', {
        firstName,
        lastName,
        email,
        phone,
        profileImage,
        street,
        city,
        country,
        state,
        postalCode
      });
  
      if (!user) {
        return res.status(400).json({
          message: "The middleware is not working"
        });
      }
  
      db = await setupConnection();
      await db.beginTransaction(); // Start a transaction
  
      // Update Customer table
      const updateCustomerQuery = `
        UPDATE Customer 
        SET first_name = ?, last_name = ?, email = ?, phone = ?, profile_image = ? 
        WHERE customer_id = ?
      `;
      await db.execute(updateCustomerQuery, [firstName, lastName, email, phone, profileImage, user.customer_id]);
  
      // Check if the address exists for the user
      const checkAddressQuery = `SELECT * FROM Address WHERE customer_id = ?`;
      const [addressRows] = await db.execute(checkAddressQuery, [user.customer_id]);
  
      if (addressRows.length > 0) {
        // Address exists, so update it
        const updateAddressQuery = `
          UPDATE Address 
          SET street = ?, city = ?, country = ?, state = ?, postal_code = ? 
          WHERE customer_id = ?
        `;
        await db.execute(updateAddressQuery, [street, city, country, state, postalCode, user.customer_id]);
      } else {
        // Address does not exist, so create it
        const addressId = `ADDR${Date.now()}`; // Generate a unique address ID
        const createAddressQuery = `
          INSERT INTO Address (address_id, customer_id, street, city, state, postal_code, country)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        await db.execute(createAddressQuery, [addressId, user.customer_id, street, city, state, postalCode, country]);
      }
  
      await db.commit(); // Commit the transaction
  
      return res.status(200).json({
        message: "User and address data updated successfully"
      });
    } catch (error) {
      if (db) {
        await db.rollback(); // Rollback the transaction on error
      }
      console.error("Error occurred while updating the user data:", error);
      return res.status(500).json({
        message: "Error occurred while updating the user data"
      });
    }
  };
  